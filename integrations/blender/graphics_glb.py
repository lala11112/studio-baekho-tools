"""Self-contained GLB derivatives with exact packed bytes for unchanged images.

Blender's keep_originals mode is for external glTF images: in Blender 5 it can
emit both a URI and a dummy GLB image, and bypasses required ORM composition.
Use normal channel mapping instead. The scoped encoder preserves packed bytes
only when every used channel maps unchanged from the same original image.
"""
import hashlib
import json
import pathlib
import struct
import tempfile
from contextlib import contextmanager


def _texture_uv_name(node, chosen, names):
    """Resolve only explicit, understood texture-vector routes; never guess UV sets."""
    socket=node.inputs.get('Vector')
    seen=set()
    while socket and socket.is_linked:
        if len(socket.links)!=1: raise RuntimeError('모호한 텍스처 UV 연결은 내보낼 수 없습니다.')
        link=socket.links[0]; source=link.from_node
        if source.as_pointer() in seen: raise RuntimeError('순환 텍스처 UV 연결은 지원하지 않습니다.')
        seen.add(source.as_pointer())
        if source.type=='UVMAP':
            if source.from_instancer: raise RuntimeError('인스턴서 UV 좌표는 이 내보내기에서 지원하지 않습니다.')
            name=source.uv_map or chosen; break
        if source.type=='ATTRIBUTE':
            if source.attribute_type!='GEOMETRY': raise RuntimeError('메시 UV가 아닌 객체·인스턴서 속성 좌표는 지원하지 않습니다.')
            name=source.attribute_name; break
        if source.type=='TEX_COORD' and link.from_socket.name=='UV':
            if source.from_instancer: raise RuntimeError('인스턴서 UV 좌표는 이 내보내기에서 지원하지 않습니다.')
            name=chosen; break
        if source.type in {'MAPPING','REROUTE'}:
            socket=source.inputs.get('Vector') if source.type=='MAPPING' else source.inputs[0]
            if not socket or not socket.is_linked: raise RuntimeError('상수 텍스처 좌표 연결은 이 UV 내보내기에서 지원하지 않습니다.')
            continue
        raise RuntimeError('확인할 수 없는 텍스처 좌표 연결입니다. 명시적인 UV Map을 사용하세요.')
    else: name=chosen
    if name not in names: raise RuntimeError('텍스처가 참조하는 UV 층이 없습니다: '+str(name))
    return name


def _export_uv_bindings(obj, chosen, names, fbx):
    bindings=[]
    for slot in obj.material_slots:
        material=slot.material
        if not material or not material.use_nodes: continue
        outputs=[n for n in material.node_tree.nodes if n.type=='OUTPUT_MATERIAL' and n.is_active_output]
        stack=list(outputs); seen=set()
        while stack:
            node=stack.pop()
            if node.as_pointer() in seen: continue
            seen.add(node.as_pointer())
            if node.type=='GROUP': raise RuntimeError('내보내기 UV를 확인할 수 없는 재질 노드 그룹입니다.')
            if node.type=='TEX_IMAGE' and node.image:
                name=_texture_uv_name(node,chosen,names)
                if fbx and name!=chosen:
                    raise RuntimeError('FBX는 선택 UV와 다른 UV 층의 텍스처 연결을 보존할 수 없습니다. GLB만 내보내기를 선택하세요: '+name)
                bindings.append({'material':material.name,'image':node.image.name,'uvLayer':name,'texCoord':([chosen]+[n for n in names if n!=chosen]).index(name)})
            if node.type=='NORMAL_MAP' and node.uv_map and node.uv_map!=chosen:
                raise RuntimeError('선택 UV와 다른 탄젠트 노멀 UV 층은 이 내보내기에서 지원하지 않습니다.')
            for socket in node.inputs:
                stack.extend(link.from_node for link in socket.links)
    return bindings


def _uv_corners(layer):
    # Blender 5 removed MeshUVLoop.select/select_edge; retain them on older APIs.
    return [(tuple(v.uv),v.pin_uv,getattr(v,'select',None),getattr(v,'select_edge',None)) for v in layer.data]


def _uv_snapshot(data):
    return {'activeIndex':data.uv_layers.active_index,'layers':[(layer.name,layer.active_render,getattr(layer,'active_clone',None),_uv_corners(layer)) for layer in data.uv_layers]}


@contextmanager
def active_uv_first_export(meshes, fbx=False):
    """Opt-in private mesh copies; all UV names/corners survive, editable data stays exact.

    Existing callers of export_packed_glb are unchanged. FBX does not write UVSet
    texture bindings, so a reachable texture using another set fails before export.
    """
    import bpy
    plans=[]; records=[]; swapped=[]
    for obj in meshes:
        data=obj.data; layers=list(data.uv_layers)
        if not layers:
            _export_uv_bindings(obj,None,[],fbx)
            continue
        active=data.uv_layers.active; render=[layer for layer in layers if layer.active_render]
        if active is None or len(render)!=1 or active!=render[0]:
            raise RuntimeError('내보내기 UV의 편집 선택과 렌더 선택이 다릅니다. 사용할 UV 층 하나를 명시적으로 선택하세요: '+obj.name)
        names=[layer.name for layer in layers]; chosen=active.name
        bindings=_export_uv_bindings(obj,chosen,names,fbx)
        snapshot=_uv_snapshot(data);states={layer.name:_uv_corners(layer) for layer in layers}
        plans.append((obj,data,names,chosen,states,snapshot))
        records.append({'mesh':obj.name,'sourceLayer':chosen,'exportLayer':chosen,'sourceOrder':names,'exportOrder':[chosen]+[name for name in names if name!=chosen],'layerCount':len(layers),'policy':'active-first-preserve-all','textureBindings':bindings})
    try:
        for obj,original,names,chosen,states,snapshot in plans:
            copy=original.copy(); swapped.append((obj,original,copy,snapshot));obj.data=copy
            for name in [layer.name for layer in copy.uv_layers]:copy.uv_layers.remove(copy.uv_layers[name])
            for name in [chosen]+[name for name in names if name!=chosen]:
                layer=copy.uv_layers.new(name=name,do_init=False)
                if layer.name!=name: raise RuntimeError('UV 이름을 정확히 보존할 수 없습니다: '+name)
                for item,(uv,pin,select,edge) in zip(layer.data,states[name]):
                    item.uv=uv;item.pin_uv=pin
                    if select is not None:item.select=select
                    if edge is not None:item.select_edge=edge
                if _uv_corners(layer)!=states[name]: raise RuntimeError('내보내기 복사본의 UV 모서리 데이터가 달라졌습니다.')
                if any(row[0]==name and row[2] is True for row in snapshot['layers']):layer.active_clone=True
            copy.uv_layers.active_index=0;copy.uv_layers[0].active_render=True
        yield records
    finally:
        errors=[]
        for obj,original,copy,snapshot in reversed(swapped):
            try:obj.data=original
            except Exception as error:errors.append(str(error))
        for obj,original,copy,snapshot in reversed(swapped):
            try:bpy.data.meshes.remove(copy)
            except Exception as error:errors.append(str(error))
            if _uv_snapshot(original)!=snapshot:errors.append('내보내기 중 원본 UV 순서·선택·모서리 데이터가 변경됐습니다.')
        if errors:raise RuntimeError(' · '.join(errors))


def image_mime(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if raw.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    raise RuntimeError('Unsupported encoded GLB image')


def inspect_glb(raw):
    if len(raw) < 20 or struct.unpack_from('<4sII', raw) != (b'glTF', 2, len(raw)):
        raise RuntimeError('Invalid GLB header')
    chunks, offset = {}, 12
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise RuntimeError('Truncated GLB chunk')
        size, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        if size % 4 or offset + size > len(raw) or kind in chunks:
            raise RuntimeError('Invalid GLB chunk')
        chunks[kind] = raw[offset:offset + size]
        offset += size
    document = json.loads(chunks[0x4e4f534a])
    binary = chunks.get(0x004e4942, b'')
    buffers = document.get('buffers', [])
    if len(buffers) != 1 or 'uri' in buffers[0] or not 0 <= buffers[0]['byteLength'] <= len(binary):
        raise RuntimeError('GLB must contain a single embedded buffer')
    images = []
    for image in document.get('images', []):
        if 'uri' in image or not isinstance(image.get('bufferView'), int):
            raise RuntimeError('GLB image is not self-contained')
        view = document['bufferViews'][image['bufferView']]
        start, size = view.get('byteOffset', 0), view['byteLength']
        if view.get('buffer', 0) != 0 or start < 0 or size <= 0 or start + size > buffers[0]['byteLength']:
            raise RuntimeError('GLB image buffer is out of range')
        encoded = binary[start:start + size]
        if image_mime(encoded) != image.get('mimeType'):
            raise RuntimeError('GLB image MIME differs from encoded bytes')
        images.append({'name': image.get('name', ''), 'mimeType': image['mimeType'],
                       'sha256': hashlib.sha256(encoded).hexdigest(), 'bytes': len(encoded)})
    return images


def export_packed_glb(output_path, **export_kwargs):
    import bpy
    from io_scene_gltf2.blender.exp.material.encode_image import ExportImage, FillImage

    target = pathlib.Path(output_path).resolve()
    if target.exists():
        raise RuntimeError('Existing GLB must be preserved; choose a new derivative identity')
    if any(key in export_kwargs for key in ('filepath', 'export_format', 'export_image_format', 'export_keep_originals')):
        raise RuntimeError('GLB image preservation settings are host-owned')
    target.parent.mkdir(parents=True, exist_ok=True)
    encode = ExportImage.encode
    evidence = {}

    def exact_or_composed(self, mime_type, settings):
        fills = list(self.fills.items())
        direct = (fills and not self.stored and self.numpy_calc is None
                  and all(isinstance(fill, FillImage) and channel == fill.src_chan for channel, fill in fills)
                  and len({fill.image.as_pointer() for _, fill in fills}) == 1)
        sources = list({fill.image.as_pointer(): fill.image for _, fill in fills if hasattr(fill, 'image')}.values())
        record = {'mode': 'composed', 'sources': [image.name for image in sources],
                  'size': [max((image.size[axis] for image in sources), default=1) for axis in (0, 1)]}
        if direct:
            image = fills[0][1].image
            if image.source != 'FILE' or not image.packed_file or image.is_dirty or min(image.size) < 1:
                raise RuntimeError('Unchanged GLB texture requires clean original packed data: ' + image.name)
            original = bytes(image.packed_file.data)
            # Alpha conversions may legitimately require PNG; never label a JPEG
            # as PNG or replace a composed ORM image just because names match.
            if image_mime(original) == mime_type:
                data, factor = original, None
                record['mode'] = 'original'
                settings['exported_images'][image.name] = 1
            else:
                data, factor = encode(self, mime_type, settings)
                record['mode'] = 'converted'
        else:
            data, factor = encode(self, mime_type, settings)
        if image_mime(data) != mime_type:
            raise RuntimeError('Encoded image MIME mismatch')
        record.update({'mimeType': mime_type, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
        evidence[record['sha256']] = record
        return data, factor

    # Only this isolated background process is patched, and always restored.
    # No bpy.Image path/pixels, source file, material or node graph is modified.
    with tempfile.TemporaryDirectory(prefix='glb-', dir=str(target.parent)) as temporary:
        staged = pathlib.Path(temporary) / 'asset.glb'
        ExportImage.encode = exact_or_composed
        try:
            bpy.ops.export_scene.gltf(filepath=str(staged), export_format='GLB',
                                     export_image_format='AUTO', export_keep_originals=False, **export_kwargs)
        finally:
            ExportImage.encode = encode
        raw = staged.read_bytes()
        images = inspect_glb(raw)
        if any(image['sha256'] not in evidence for image in images):
            raise RuntimeError('GLB contains an image without encoder evidence')
        # Exclusive final creation: registered originals or prior derivatives can
        # never be replaced, even if another writer raced the initial check.
        with target.open('xb') as stream:
            stream.write(raw)
    return [{**evidence[image['sha256']], 'name': image['name']} for image in images]

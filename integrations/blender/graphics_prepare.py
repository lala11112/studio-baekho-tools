"""Deterministic Unity derivative; no authoring, online operations, or source writes."""
import bpy, json, pathlib, sys, hashlib, shutil, re, math, struct, zlib
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_size import apply_physical_size, logical_parent

q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
source = pathlib.Path(q['source']).resolve()
out = pathlib.Path(q['output']).resolve()
out.mkdir(parents=True, exist_ok=False)
root = source.parent
input_root = pathlib.Path(q.get('inputRoot', str(root))).resolve()
declared = q['files']
for item in declared:
    item['local'] = str(pathlib.Path(item['local']).resolve())
    if not pathlib.Path(item['local']).is_relative_to(input_root) or hashlib.sha256(pathlib.Path(item['local']).read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('Declared source changed or escaped the private staging folder')

suffix = source.suffix.lower()
if suffix == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    if bpy.data.libraries:
        raise RuntimeError('Linked Blender libraries must be made local before Unity delivery')
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if suffix == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
    elif suffix == '.glb':
        # A GLB with external URIs is not a self-contained source. Do not let the importer search outside staging.
        raw = source.read_bytes()
        if raw[:4] != b'glTF' or int.from_bytes(raw[4:8], 'little') != 2:
            raise RuntimeError('Invalid GLB source')
        length = int.from_bytes(raw[12:16], 'little')
        data = json.loads(raw[20:20+length].decode('utf8').rstrip('\x00 '))
        for item in data.get('buffers', []) + data.get('images', []):
            if item.get('uri') and not item['uri'].startswith('data:'):
                raise RuntimeError('GLB external URI requires an explicit self-contained import')
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif suffix == '.obj':
        text = source.read_text(encoding='utf8', errors='strict')
        for name in re.findall(r'^mtllib\s+(.+)$', text, re.MULTILINE):
            if ':' in name or pathlib.Path(name.strip()).is_absolute():
                raise RuntimeError('OBJ material path must be local and declared')
            material_path = (root/name.strip()).resolve()
            if not material_path.is_relative_to(input_root):
                raise RuntimeError('OBJ material escaped source manifest root')
            found = [f for f in declared if pathlib.Path(f['local']) == material_path]
            if len(found) != 1:
                raise RuntimeError('OBJ material file missing from source manifest: '+name)
            material = pathlib.Path(found[0]['local']).read_text(encoding='utf8')
            for map_name in re.findall(r'^\s*(?:map_\w+|bump|disp|decal|norm)\s+(.+)$', material, re.MULTILINE):
                # Options and external paths need deliberate import rather than a speculative file search.
                if ':' in map_name or pathlib.Path(map_name.strip()).is_absolute() or map_name.startswith('-'):
                    raise RuntimeError('OBJ texture path requires an explicit contained import')
                image_path = (material_path.parent/map_name.strip()).resolve()
                if not image_path.is_relative_to(input_root):
                    raise RuntimeError('OBJ texture escaped source manifest root')
                images = [f for f in declared if pathlib.Path(f['local']) == image_path]
                if len(images) != 1:
                    raise RuntimeError('OBJ texture missing from source manifest: '+map_name)
        bpy.ops.wm.obj_import(filepath=str(source))
    else:
        raise RuntimeError('Unsupported model format')

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
if not meshes or any(len(o.data.vertices) == 0 for o in meshes):
    raise RuntimeError('Model has no usable mesh')
if len(rigs) > 1:
    raise RuntimeError('Multiple skeletons require an explicit compatible export')
physical_size = apply_physical_size(q.get('physicalSize'), hashlib.sha256(source.read_bytes()).hexdigest())
(out/'physical-size.json').write_text(json.dumps(physical_size,ensure_ascii=False),encoding='utf8')

textures = out/'Textures'
textures.mkdir()
warnings = []
image_files = {}
for index, image in enumerate(bpy.data.images):
    if image.type == 'RENDER_RESULT' or image.source not in {'FILE', 'GENERATED'}:
        continue
    if image.packed_file:
        raw = bytes(image.packed_file.data)
    else:
        basename = pathlib.Path(image.filepath.replace('\\','/')).name
        matches = [f for f in declared if pathlib.Path(f['original']).name == basename]
        current = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
        if len(matches) == 1:
            raw = pathlib.Path(matches[0]['local']).read_bytes()
        elif current.is_file() and current.is_relative_to(input_root):
            raw = current.read_bytes()
        else:
            raise RuntimeError('Texture is not packed or declared in the immutable source: '+image.name)
    extension = '.png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else None
    if extension is None:
        raise RuntimeError('Texture is not a preserved PNG/JPEG: '+image.name)
    # Stable image names preserve importer material bindings; bytes are never resampled.
    name = re.sub(r'[^A-Za-z0-9_-]', '_', pathlib.Path(image.name).stem) or 'Texture'
    texture = textures/(str(index)+'_'+name+extension)
    texture.write_bytes(raw)
    image.filepath = str(texture)
    image_files[image.name] = {'path':texture.relative_to(out).as_posix(),
        'sha256':hashlib.sha256(raw).hexdigest(),'width':image.size[0],'height':image.size[1]}

# The FBX material representation cannot describe arbitrary Blender node graphs.
# Bind only this explicit opaque Principled subset; never infer roles from filenames.
class UnsupportedMaterial(Exception):
    pass

def linked(socket):
    if len(socket.links) != 1:
        raise UnsupportedMaterial('Expected exactly one direct node link: '+socket.name)
    link = socket.links[0]
    return link.from_node, link.from_socket.name

def image_input(socket, color_space):
    node, channel = linked(socket)
    if node.type != 'TEX_IMAGE' or channel != 'Color' or not node.image:
        raise UnsupportedMaterial('Only direct image Color nodes are supported: '+socket.name)
    image = node.image
    if node.inputs['Vector'].is_linked or node.projection != 'FLAT' or node.extension != 'REPEAT' or node.interpolation != 'Linear':
        raise UnsupportedMaterial('Mapped UVs, projection, non-repeat or non-linear sampling need explicit material authoring')
    if image.source != 'FILE' or image.is_dirty or image.name not in image_files or image.alpha_mode == 'PREMUL':
        raise UnsupportedMaterial('Material image must be an unchanged packed or declared file')
    if image.colorspace_settings.name != color_space:
        raise UnsupportedMaterial('Unexpected color space for '+image.name+': '+image.colorspace_settings.name)
    return image

def scalar_input(socket):
    if not socket.is_linked:
        value = float(socket.default_value)
        if not math.isfinite(value) or not 0 <= value <= 1:
            raise UnsupportedMaterial('Scalar outside supported 0..1 range: '+socket.name)
        return {'value':value}
    node, channel = linked(socket)
    if node.type == 'TEX_IMAGE' and channel == 'Color':
        # A Non-Color image with exactly equal RGB components is already scalar
        # data. Prove that below for every pixel; never choose a channel from a
        # colored image or guess color-to-value/luminance conversion weights.
        return {'image':image_input(socket, 'Non-Color'),'channel':'GRAYSCALE'}
    if node.type != 'SEPARATE_COLOR' or node.mode != 'RGB' or channel not in {'Red','Green','Blue'}:
        raise UnsupportedMaterial('Scalar requires an RGB Separate Color channel: '+socket.name)
    image = image_input(node.inputs['Color'], 'Non-Color')
    return {'image':image,'channel':{'Red':0,'Green':1,'Blue':2}[channel]}

def png_rgba(destination, pixels):
    # Blender pixel arrays run bottom-to-top. PNG rows run top-to-bottom.
    values = np.rint(np.clip(pixels,0,1)*255).astype(np.uint8)[::-1]
    height,width,_ = values.shape
    rows = np.zeros((height,width*4+1),dtype=np.uint8)
    rows[:,1:] = values.reshape(height,width*4)
    def chunk(kind, data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+
        chunk(b'IDAT',zlib.compress(rows.tobytes(),6))+chunk(b'IEND',b''))

def metallic_gloss(material, metallic, roughness):
    images = {v['image'].name:v['image'] for v in (metallic,roughness) if 'image' in v}
    if not images:
        return ''
    sizes = {tuple(image.size) for image in images.values()}
    if len(sizes) != 1 or any(v <= 0 for v in next(iter(sizes))):
        raise UnsupportedMaterial('Metallic and roughness dimensions differ; no texture resizing is inferred')
    width,height = next(iter(sizes))
    rgba = np.zeros((height,width,4),dtype=np.float32)
    for image in images.values():
        pixels = np.empty(width*height*4,dtype=np.float32)
        image.pixels.foreach_get(pixels)
        pixels = pixels.reshape(height,width,4)
        if any(value.get('image') == image and value.get('channel') == 'GRAYSCALE' for value in (metallic,roughness)):
            if not np.array_equal(pixels[:,:,0],pixels[:,:,1]) or not np.array_equal(pixels[:,:,0],pixels[:,:,2]):
                raise UnsupportedMaterial('Direct scalar image requires exactly equal RGB values; colored luminance conversion is not inferred: '+image.name)
        if metallic.get('image') == image:
            rgba[:,:,0] = pixels[:,:,0 if metallic['channel'] == 'GRAYSCALE' else metallic['channel']]
        if roughness.get('image') == image:
            rgba[:,:,3] = 1-pixels[:,:,0 if roughness['channel'] == 'GRAYSCALE' else roughness['channel']]
        del pixels
    if 'value' in metallic:
        rgba[:,:,0] = metallic['value']
    if 'value' in roughness:
        rgba[:,:,3] = 1-roughness['value']
    target = out/'Textures'/'Derived'/('metallic-smoothness-'+hashlib.sha256(material.name.encode()).hexdigest()[:16]+'.png')
    png_rgba(target,rgba)
    return target.relative_to(out).as_posix()

def material_binding(material):
    record = {'name':material.name,'supported':False,'warning':''}
    try:
        if not material.use_nodes or not material.node_tree:
            raise UnsupportedMaterial('Material has no Principled node graph')
        outputs = [n for n in material.node_tree.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output]
        if len(outputs) != 1 or outputs[0].inputs['Displacement'].is_linked:
            raise UnsupportedMaterial('Material output or displacement requires explicit authoring')
        principled, output = linked(outputs[0].inputs['Surface'])
        if principled.type != 'BSDF_PRINCIPLED' or output != 'BSDF':
            raise UnsupportedMaterial('Only a direct Principled surface is supported')
        inputs = principled.inputs
        if inputs['Alpha'].is_linked or abs(inputs['Alpha'].default_value-1) > 1e-6:
            raise UnsupportedMaterial('Transparency requires explicit material authoring')
        for name in ['Subsurface Weight','Transmission Weight','Coat Weight','Sheen Weight','Anisotropic','Thin Film Thickness']:
            if name in inputs and (inputs[name].is_linked or abs(inputs[name].default_value) > 1e-6):
                raise UnsupportedMaterial('Unsupported Principled property: '+name)
        for name,value in [('IOR',1.5),('Specular IOR Level',0.5),('Diffuse Roughness',0.0)]:
            if name in inputs and (inputs[name].is_linked or abs(inputs[name].default_value-value)>1e-6):
                raise UnsupportedMaterial('Non-default specular/diffuse response requires explicit authoring: '+name)
        if inputs['Specular Tint'].is_linked or any(abs(v-1)>1e-6 for v in inputs['Specular Tint'].default_value[:3]):
            raise UnsupportedMaterial('Specular tint requires explicit material authoring')
        if inputs['Emission Strength'].is_linked or (inputs['Emission Strength'].default_value > 0 and
            (inputs['Emission Color'].is_linked or any(abs(v)>1e-6 for v in inputs['Emission Color'].default_value[:3]))):
            raise UnsupportedMaterial('Emission requires explicit material authoring')
        base = image_input(inputs['Base Color'],'sRGB') if inputs['Base Color'].is_linked else None
        record['baseColor'] = [1,1,1,1] if base else list(inputs['Base Color'].default_value)
        record['baseColorTexture'] = image_files[base.name]['path'] if base else ''
        record['normalTexture'],record['normalScale'] = '',1.0
        if inputs['Normal'].is_linked:
            normal, output = linked(inputs['Normal'])
            if normal.type != 'NORMAL_MAP' or output != 'Normal' or normal.space != 'TANGENT' or normal.inputs['Strength'].is_linked:
                raise UnsupportedMaterial('Normal requires an unmodified tangent-space Normal Map node')
            if normal.uv_map and any(len(o.data.uv_layers)!=1 or o.data.uv_layers[0].name!=normal.uv_map for o in meshes if material in o.data.materials[:]):
                raise UnsupportedMaterial('Normal Map UV name does not match the single exported UV map')
            normal_image = image_input(normal.inputs['Color'],'Non-Color')
            record['normalTexture'] = image_files[normal_image.name]['path']
            record['normalScale'] = float(normal.inputs['Strength'].default_value)
            if not math.isfinite(record['normalScale']) or not 0<=record['normalScale']<=8:
                raise UnsupportedMaterial('Normal strength is outside the supported 0..8 range')
        metallic,roughness = scalar_input(inputs['Metallic']),scalar_input(inputs['Roughness'])
        if record['normalTexture'] and any('image' in value and image_files[value['image'].name]['path']==record['normalTexture'] for value in (metallic,roughness)):
            raise UnsupportedMaterial('One texture used as both normal and scalar data needs distinct Unity importer assets')
        record['metallicGlossTexture'] = metallic_gloss(material,metallic,roughness)
        if any(record.get(key) for key in ['baseColorTexture','normalTexture','metallicGlossTexture']) and any(len(o.data.uv_layers)!=1 for o in meshes if material in o.data.materials[:]):
            raise UnsupportedMaterial('Textured materials require exactly one UV map; UV selection is not inferred')
        record['metallic'] = metallic.get('value',1.0)
        record['smoothness'] = 1-roughness['value'] if 'value' in roughness else 1.0
        for name,value in [('metallicSource',metallic),('roughnessSource',roughness)]:
            record[name] = {'path':image_files[value['image'].name]['path'],'channel':'GRAYSCALE' if value['channel'] == 'GRAYSCALE' else 'RGB'[value['channel']]} if 'image' in value else {'value':value['value']}
        record['supported'] = True
    except UnsupportedMaterial as error:
        record = {'name':material.name,'supported':False,'warning':str(error)}
        warnings.append('Material '+material.name+' was not exactly converted: '+str(error))
    return record

bindings = [material_binding(material) for material in sorted({m for o in meshes for m in o.data.materials if m},key=lambda m:m.name)]
derived_images = []
for record in bindings:
    if record.get('metallicGlossTexture'):
        raw = (out/record['metallicGlossTexture']).read_bytes()
        width,height = struct.unpack('>II',raw[16:24])
        derived_images.append({'path':record['metallicGlossTexture'],'sha256':hashlib.sha256(raw).hexdigest(),'width':width,'height':height})
(out/'materials.json').write_text(json.dumps({'schemaVersion':1,'materials':bindings,
    'originalImages':list(image_files.values()),'derivedImages':derived_images,
    'packing':'Unity metallic R, smoothness A = 1 - Blender roughness; unchanged source bytes retained'},ensure_ascii=False),encoding='utf8')

def signature(o):
    return {'name': o.name, 'parent': logical_parent(o),
            'vertices': len(o.data.vertices), 'edges': len(o.data.edges),
            'polygons': [list(p.vertices) for p in o.data.polygons],
            'materials': [m.name if m else '' for m in o.data.materials]}

structure = {'meshes': sorted([signature(o) for o in meshes], key=lambda m:m['name']),
             'bones': [{'name':b.name,'parent':b.parent.name if b.parent else None,
                        'bind':[round(v,6) for row in b.matrix_local for v in row]}
                       for rig in rigs for b in rig.data.bones]}
if q.get('rigContract', {}).get('rigType') == 'humanoid':
    from graphics_humanoid import inspect_humanoid
    rig_evidence = inspect_humanoid(q['rigContract'], imported_auto_rig_fbx=suffix == '.fbx' and q['rigContract'].get('exportPolicy') == 'auto-rig-fbx')
    rig_evidence['sourceSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    (out/'rig.json').write_text(json.dumps(rig_evidence, ensure_ascii=False), encoding='utf8')
clips = sorted(a.name for a in bpy.data.actions if a.frame_range[1] > a.frame_range[0])
clip_settings=q.get('clipSettings',[])
clip_evidence=[]
source_fps=bpy.context.scene.render.fps/bpy.context.scene.render.fps_base
for setting in clip_settings:
    action=bpy.data.actions.get(setting['name'])
    if not action or action.name not in clips:
        raise RuntimeError('Exact selected animation contract Action is missing: '+setting['name'])
    if not math.isfinite(source_fps) or abs(source_fps-setting['fps'])>.0001:
        raise RuntimeError('Animation FPS differs from the frozen clip contract; timing is not resampled: '+setting['name'])
    if len(rigs)!=1:
        raise RuntimeError('Managed animation contracts require exactly one armature')
    roots=[bone.name for bone in rigs[0].data.bones if bone.parent is None]
    if setting['rootMotion'] and len(roots)!=1:
        raise RuntimeError('Root motion needs one unambiguous source skeleton root bone')
    clip_evidence.append({'name':setting['name'],'sourceFps':source_fps,'firstFrame':float(action.frame_range[0]),'lastFrame':float(action.frame_range[1]),
        'armatureName':rigs[0].name,'rootBoneName':roots[0] if len(roots)==1 else ''})
(out/'animation.json').write_text(json.dumps({'schemaVersion':1,'clipSettings':clip_settings,'clips':clip_evidence},ensure_ascii=False),encoding='utf8')
if clips and not rigs:
    warnings.append('Transform animation is retained; skeletal deformation was not verified.')
if any(o.modifiers for o in meshes):
    warnings.append('Blender modifiers are evaluated in the FBX derivative; source geometry remains unchanged.')

optimization=q.get('optimization',{})
lods=[]
lod_enabled=optimization.get('lodEnabled',False)
if lod_enabled:
    ratio=float(optimization.get('lodRatio',.5))
    if not .05<=ratio<=.95:
        raise RuntimeError('LOD ratio must be between .05 and .95')
    if rigs or clips or any(o.data.shape_keys or o.modifiers for o in meshes):
        raise RuntimeError('Local LOD supports static meshes without shape keys, animation or modifiers only')
    for original in list(meshes):
        name=original.name+'__PS_LOD1'
        if name in bpy.data.objects:
            raise RuntimeError('LOD derivative name collides with an original object')
        derived=original.copy();derived.data=original.data.copy();derived.name=name;bpy.context.collection.objects.link(derived)
        bpy.ops.object.select_all(action='DESELECT');derived.select_set(True);bpy.context.view_layer.objects.active=derived
        decimate=derived.modifiers.new('Partsmith delivery LOD','DECIMATE');decimate.ratio=ratio;decimate.use_collapse_triangulate=True
        before=sum(max(0,len(p.vertices)-2) for p in original.data.polygons)
        bpy.ops.object.modifier_apply(modifier=decimate.name)
        after=sum(max(0,len(p.vertices)-2) for p in derived.data.polygons)
        if after>=before or after<1:
            raise RuntimeError('LOD could not reduce this mesh; original preserved: '+original.name)
        lods.append({'source':original.name,'derived':derived.name,'sourceTriangles':before,'derivedTriangles':after})
        meshes.append(derived)
    warnings.append('LOD1 is a local decimation derivative. Silhouette, UV distortion and switching need visual review.')
if optimization.get('collider') in {'mesh','convex'} and rigs:
    raise RuntimeError('Mesh/convex collision delivery supports static meshes only; choose box for a rig')
(out/'optimization.json').write_text(json.dumps({'schemaVersion':1,'settings':optimization,'lods':lods},ensure_ascii=False),encoding='utf8')

export_uv=[]
if q.get('activeUvOnly'):
    if rigs or clips or any(o.data.shape_keys or o.modifiers or o.constraints for o in meshes):
        raise RuntimeError('Active-only UV delivery requires the verified static planar model')
    for obj in meshes:
        active=obj.data.uv_layers.active
        if active is None:
            raise RuntimeError('Verified planar model is missing its active delivery UV')
        name=active.name
        expected=[tuple(item.uv) for item in active.data]
        # Private export data only: never save or rewrite the editable native source/layers.
        obj.data=obj.data.copy()
        for other in [layer.name for layer in obj.data.uv_layers]:
            if other!=name: obj.data.uv_layers.remove(obj.data.uv_layers[other])
        obj.data.uv_layers.active_index=0;obj.data.uv_layers[0].active_render=True
        if expected!=[tuple(item.uv) for item in obj.data.uv_layers[0].data]:
            raise RuntimeError('Active delivery UV changed while creating the export copy')
        export_uv.append({'mesh':obj.name,'layer':name,'uv0MatchesActive':True,'sourceLayersPreserved':True})
if suffix == '.fbx' and not lod_enabled and not physical_size['transformed'] and not q.get('activeUvOnly'):
    # Preserve native animation curves and original FBX bytes instead of re-encoding them.
    shutil.copyfile(source, out/'Asset.fbx')
    # FBX take names are reported by Unity rather than guessed from Blender action names.
    clips = []
else:
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes + rigs + [o for o in bpy.context.scene.objects if o.type=='EMPTY']:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rigs[0] if rigs else meshes[0]
    bpy.ops.export_scene.fbx(filepath=str(out/'Asset.fbx'), use_selection=True,
        object_types={'ARMATURE','MESH','EMPTY'}, axis_forward='-Z', axis_up='Y',
        apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS', add_leaf_bones=False, bake_anim=bool(clips),
        bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0, path_mode='COPY', embed_textures=True)
warnings.append('Import checks do not establish visual material fidelity or animation playback quality.')
(out/'inspection.json').write_text(json.dumps({'structure':structure,'clips':clips,
    'bones':sum(len(r.data.bones) for r in rigs),'warnings':warnings,
    'sourceChanged':False,'animationAuthored':False,'physicalSize':physical_size,'exportUv':export_uv},ensure_ascii=False),encoding='utf8')

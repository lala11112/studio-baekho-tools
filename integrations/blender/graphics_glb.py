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

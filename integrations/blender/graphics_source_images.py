"""Load only embedded or explicitly registered images; never search or re-encode."""
import hashlib
import pathlib
import unicodedata
import bpy


def companion_name(value):
    return unicodedata.normalize('NFC', str(value).replace('\\', '/').rsplit('/', 1)[-1]).casefold()


def import_fbx_deferred(source):
    from bpy_extras import image_utils
    original_load = image_utils.load_image

    def placeholder(filepath, **kwargs):
        image = bpy.data.images.new(companion_name(filepath), width=1, height=1)
        image.source = 'FILE'
        image.filepath = str(filepath)
        return image

    image_utils.load_image = placeholder
    try:
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
    finally:
        image_utils.load_image = original_load


def pack_registered_companions(q, source):
    manifest, resources = q.get('sourceCompanions', []), q.get('companionResources', [])
    if manifest and q.get('sourceManifestVersion') != 1:
        raise ValueError('Unsupported companion manifest')
    if len(manifest) != len(resources):
        raise ValueError('Companion manifest mismatch')
    allowed = {}
    for file, resource in zip(manifest, resources):
        name = companion_name(file['path'])
        staged = pathlib.Path(resource['stagedPath']).resolve()
        if not name or name in allowed or resource['file'] != file or staged.parent != source.parent or companion_name(staged.name) != name or not staged.is_file():
            raise ValueError('Ambiguous or invalid companion path')
        data = staged.read_bytes()
        if len(data) != file['bytes'] or hashlib.sha256(data).hexdigest() != file['sha256']:
            raise ValueError('Companion bytes changed')
        allowed[name] = (staged, file)
    evidence = []
    for image in bpy.data.images:
        if image.source == 'VIEWER':
            continue
        if image.source != 'FILE':
            raise ValueError('Unsupported image source: ' + image.name)
        match = allowed.get(companion_name(image.filepath))
        if image.packed_file:
            if match and hashlib.sha256(bytes(image.packed_file.data)).hexdigest() != match[1]['sha256']:
                raise ValueError('Embedded image and registered companion disagree')
        else:
            if not match:
                raise ValueError('Unlisted external image: ' + image.name)
            staged, file = match
            image.filepath = str(staged)
            image.reload()
            image.pack()
            if not image.packed_file or hashlib.sha256(bytes(image.packed_file.data)).hexdigest() != file['sha256']:
                raise ValueError('Packed companion hash mismatch')
        evidence.append({'name': image.name, 'registeredPath': match[1]['path'] if match else None,
                         'sha256': hashlib.sha256(bytes(image.packed_file.data)).hexdigest(),
                         'bytes': len(image.packed_file.data)})
    return evidence

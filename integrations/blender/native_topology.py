"""Read-only source -> immutable GLB + exact native polygon-edge correspondence.

Native vertex and polygon identities cross the exporter as attributes. We never
guess a quad from triangle angles/positions. Unsupported modifiers stop here.
"""
import bpy
import collections
import hashlib
import json
import math
import pathlib
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from graphics_glb import export_packed_glb

VERTEX = '_PARTSMITH_SOURCE_VERTEX'
FACE = '_PARTSMITH_SOURCE_FACE'


def read_glb(file):
    raw = pathlib.Path(file).read_bytes()
    size, kind = struct.unpack_from('<II', raw, 12)
    if kind != 0x4e4f534a:
        raise RuntimeError('Invalid GLB JSON')
    doc = json.loads(raw[20:20 + size])
    length, binary_kind = struct.unpack_from('<II', raw, 20 + size)
    if binary_kind != 0x004e4942:
        raise RuntimeError('Invalid GLB buffer')
    binary = raw[28 + size:28 + size + length]

    def accessor(index):
        a = doc['accessors'][index]
        if 'sparse' in a or a.get('normalized'):
            raise RuntimeError('Sparse/normalized identity attribute unsupported')
        view = doc['bufferViews'][a['bufferView']]
        width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        fmt = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}[a['componentType']]
        stride = view.get('byteStride', struct.calcsize(fmt) * width)
        start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        return [struct.unpack_from('<' + fmt * width, binary, start + i * stride) for i in range(a['count'])]
    return raw, doc, accessor


def export(spec):
    source = pathlib.Path(spec['sourcePath'])
    if source.suffix.lower() == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    elif source.suffix.lower() == '.fbx':
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
    else:
        raise RuntimeError('원본 면 보기는 Blender 또는 FBX 원본이 필요합니다.')
    scene = bpy.context.scene
    if bpy.data.libraries:
        raise RuntimeError('외부 연결 라이브러리는 등록된 단독 원본으로 가져온 뒤 검사하세요.')
    scene.frame_set(scene.frame_start)
    objects = sorted([obj for obj in scene.objects if obj.type == 'MESH'], key=lambda obj: obj.name)
    if not objects:
        raise RuntimeError('원본에 메시가 없습니다.')
    bpy.ops.object.select_all(action='DESELECT')
    records = []
    for index, obj in enumerate(objects):
        unsupported = [modifier.type for modifier in obj.modifiers if modifier.show_viewport and modifier.type != 'ARMATURE']
        if unsupported:
            raise RuntimeError('원본 면 대응을 보장할 수 없는 수정자: ' + ', '.join(unsupported))
        # Copy datablocks only in this temporary Blender process, including shared meshes.
        obj.data = obj.data.copy()
        mesh = obj.data
        if len(mesh.vertices) > 2_000_000:
            raise RuntimeError('원본 정점 수가 로컬 검사 한도를 넘습니다.')
        if any(len(face.vertices) < 3 for face in mesh.polygons):
            raise RuntimeError('유효하지 않은 원본 면')
        if any(attr.name in (VERTEX, FACE) for attr in mesh.attributes):
            raise RuntimeError('원본의 예약 검사 속성을 덮어쓸 수 없습니다.')
        vertex_attr = mesh.attributes.new(VERTEX, 'FLOAT', 'POINT')
        vertex_attr.data.foreach_set('value', list(range(len(mesh.vertices))))
        face_attr = mesh.attributes.new(FACE, 'FLOAT', 'CORNER')
        values = [0] * len(mesh.loops)
        for face in mesh.polygons:
            for loop in face.loop_indices:
                values[loop] = face.index
        face_attr.data.foreach_set('value', values)
        key = 'native-' + str(index)
        obj['partsmith_topology_key'] = key
        counts = collections.Counter(len(face.vertices) for face in mesh.polygons)
        face_vertices = [list(face.vertices) for face in mesh.polygons]
        face_edges = {tuple(sorted((a, b))) for face in face_vertices for a, b in zip(face, face[1:] + face[:1])}
        if len(face_edges) != len(mesh.edges) or len({v for face in face_vertices for v in face}) != len(mesh.vertices):
            raise RuntimeError('면에 연결되지 않은 변·정점은 원본 면 선으로 표시할 수 없습니다.')
        if sum(len(face) - 2 for face in face_vertices) > 4_000_000:
            raise RuntimeError('원본 면 수가 로컬 검사 한도를 넘습니다.')
        records.append({'key': key, 'name': obj.name,
                        **({'sourceId': obj['partsmith_id']} if isinstance(obj.get('partsmith_id'), str) else {}),
                        'counts': {'vertices': len(mesh.vertices), 'edges': len(mesh.edges), 'polygons': len(mesh.polygons),
                                   'triangles': counts[3], 'quads': counts[4], 'ngons': sum(n for k, n in counts.items() if k > 4)},
                        'faces': face_vertices, 'primitives': []})
        obj.select_set(True)
        for modifier in obj.modifiers:
            if modifier.type == 'ARMATURE' and modifier.object:
                modifier.object.select_set(True)
        parent = obj.parent
        while parent:
            parent.select_set(True)
            parent = parent.parent
    # FBX imports may reference external original textures. Pack only in memory.
    for image in bpy.data.images:
        if image.source == 'FILE' and not image.packed_file and image.has_data:
            image_path = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
            mappings = {pathlib.Path(original).resolve(): staged for original, staged in spec.get('resourceMappings', {}).items()}
            if image_path in mappings:
                image.filepath = mappings[image_path]
                image_path = pathlib.Path(image.filepath).resolve()
            allowed = {pathlib.Path(file).resolve() for file in spec.get('allowedResources', [])}
            staging = pathlib.Path(spec['stagingRoot']).resolve()
            if image_path not in allowed and not image_path.is_relative_to(staging):
                raise RuntimeError('등록되지 않은 외부 텍스처를 원본 면 검사에 사용하지 않습니다: ' + image.name)
            image.pack()
    destination = pathlib.Path(spec['previewPath'])
    export_packed_glb(destination, use_selection=True, export_animations=True,
                      export_attributes=True, export_extras=True, export_apply=False)
    raw, doc, accessor = read_glb(destination)
    by_key = {record['key']: record for record in records}
    for node_index, node in enumerate(doc.get('nodes', [])):
        if 'mesh' not in node:
            continue
        record = by_key.get(node.get('extras', {}).get('partsmith_topology_key'))
        if record is None:
            raise RuntimeError('Exported mesh has no exact native identity')
        seen_faces = set()
        for primitive_index, primitive in enumerate(doc['meshes'][node['mesh']]['primitives']):
            if primitive.get('mode', 4) != 4:
                raise RuntimeError('Unsupported primitive mode')
            attributes = primitive['attributes']
            vertices = [item[0] for item in accessor(attributes[VERTEX])]
            face_ids = [item[0] for item in accessor(attributes[FACE])]
            if not all(math.isfinite(v) and v == int(v) and 0 <= v < record['counts']['vertices'] for v in vertices):
                raise RuntimeError('Native vertex identity lost during export')
            vertices = list(map(int, vertices))
            if not all(math.isfinite(v) and v == int(v) and 0 <= v < record['counts']['polygons'] for v in face_ids):
                raise RuntimeError('Native face identity lost during export')
            face_ids = list(map(int, face_ids))
            positions = accessor(attributes['POSITION'])
            if len(vertices) != len(positions) or len(face_ids) != len(positions):
                raise RuntimeError('Native attribute vertex count mismatch')
            # UV splits must have identical deformation data for the same native vertex.
            deformation = [accessor(value) for name, value in attributes.items() if name == 'POSITION' or name.startswith(('JOINTS_', 'WEIGHTS_'))]
            deformation += [accessor(target['POSITION']) for target in primitive.get('targets', []) if 'POSITION' in target]
            representatives = {}
            for i, source_id in enumerate(vertices):
                if source_id in representatives:
                    other = representatives[source_id]
                    if any(a[i] != a[other] for a in deformation):
                        raise RuntimeError('A native vertex has inconsistent deformation after export')
                else:
                    representatives[source_id] = i
            indices = [v[0] for v in accessor(primitive['indices'])] if 'indices' in primitive else list(range(len(vertices)))
            triangles = collections.Counter()
            for offset in range(0, len(indices), 3):
                tri = indices[offset:offset + 3]
                if len(tri) != 3 or len({face_ids[i] for i in tri}) != 1:
                    raise RuntimeError('Triangle no longer matches one native face')
                face_id = face_ids[tri[0]]
                if not all(vertices[i] in record['faces'][face_id] for i in tri):
                    raise RuntimeError('Triangle vertices differ from native face')
                triangles[face_id] += 1
            native_edges = set()
            for face_id, triangle_count in triangles.items():
                face = record['faces'][face_id]
                if face_id in seen_faces or triangle_count != len(face) - 2:
                    raise RuntimeError('Missing or repeated native face triangles')
                seen_faces.add(face_id)
                for a, b in zip(face, face[1:] + face[:1]):
                    native_edges.add(tuple(sorted((a, b))))
            edge_indices = []
            for a, b in sorted(native_edges):
                edge_indices.extend((representatives[a], representatives[b]))
            record['primitives'].append({'node': node_index, 'mesh': node['mesh'], 'primitive': primitive_index,
                                         'sourceVertices': vertices, 'edges': edge_indices, 'faces': sorted(triangles),
                                         'counts': {'vertices': len(set(vertices)), 'edges': len(native_edges), 'polygons': len(triangles),
                                                    'triangles': sum(len(record['faces'][f]) == 3 for f in triangles),
                                                    'quads': sum(len(record['faces'][f]) == 4 for f in triangles),
                                                    'ngons': sum(len(record['faces'][f]) > 4 for f in triangles)}})
        if seen_faces != set(range(record['counts']['polygons'])):
            raise RuntimeError('Some native faces are not exported')
    for record in records:
        if not record['primitives']:
            raise RuntimeError('Some source meshes are not exported')
        del record['faces']
    result = {**spec['identity'], 'schemaVersion': 1, 'previewSha256': hashlib.sha256(raw).hexdigest(), 'meshes': records}
    pathlib.Path(spec['mapPath']).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf8')


if __name__ == '__main__':
    request = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
    export(request)

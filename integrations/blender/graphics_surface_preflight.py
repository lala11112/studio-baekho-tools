"""Read-only coverage inspection of the exact private model copy sent for texturing."""
import bpy
import hashlib
import json
import math
import pathlib
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_glb import inspect_glb


def file_hash(file):
    return hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()


def inspect(q):
    source = pathlib.Path(q['source']).resolve()
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Surface inspection source hash mismatch')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    extension = source.suffix.lower()
    if extension == '.fbx':
        bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
    elif extension == '.glb':
        inspect_glb(source.read_bytes())
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif extension == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    elif extension == '.obj':
        # Companion MTL paths are not in this exact-file contract. Never follow
        # arbitrary paths embedded in an OBJ; a self-contained FBX/GLB is needed.
        if any(line.split() and line.split()[0].lower() == 'mtllib' for line in source.read_text(encoding='utf-8-sig').splitlines()):
            raise RuntimeError('OBJ references external materials; export a self-contained FBX/GLB before texturing')
        bpy.ops.wm.obj_import(filepath=str(source))
    elif extension == '.stl':
        bpy.ops.wm.stl_import(filepath=str(source))
    else:
        raise RuntimeError('Surface inspection requires FBX/GLB/BLEND/OBJ/STL')
    if bpy.data.libraries:
        raise RuntimeError('Linked external model data cannot be inspected as a frozen standalone source')
    report = {key: q[key] for key in ('identity', 'sourceSha256', 'sourceVersionId', 'validatorFingerprint')}
    report.update(schemaVersion=1, faces=0, triangles=0, uvMissingFaces=0, invalidUvFaces=0,
                  invalidGeometryFaces=0, materialIndexIssues=0, ambiguousUvMeshes=0,
                  meshes=[], reasons=[], localOnly=True, modelTurns=0, paidSubmissions=0,
                  blenderVersion=bpy.app.version_string,
                  limitations=['UV coverage is not an appearance, texel-density, overlap or seam-quality guarantee.'])
    for obj in sorted((obj for obj in bpy.context.scene.objects if obj.type == 'MESH'), key=lambda item: item.name):
        mesh = obj.data
        mesh.calc_loop_triangles()
        active = mesh.uv_layers.active
        renders = [layer for layer in mesh.uv_layers if layer.active_render]
        render = renders[0] if len(renders) == 1 else None
        # GLB TEXCOORD_0 and first FBX layer are the upload's default UV set.
        # Native BLEND export uses active_render. A different active/default layer
        # is never silently guessed; a single intentional export UV is required.
        default = mesh.uv_layers[0] if len(mesh.uv_layers) else None
        consumed = render if extension == '.blend' else default
        def same_uv(a, b):
            return a is not None and b is not None and len(a.data) == len(b.data) and all(tuple(x.uv) == tuple(y.uv) for x, y in zip(a.data, b.data))
        ambiguous = bool(len(mesh.uv_layers) and (len(renders) != 1 or active is None or
                         not same_uv(active, render) or not same_uv(consumed, render)))
        invalid, missing, bad_geometry, bad_material = set(), set(), set(), set()
        uv = consumed
        for face in mesh.polygons:
            if len(obj.material_slots) and (face.material_index < 0 or face.material_index >= len(obj.material_slots) or obj.material_slots[face.material_index].material is None):
                bad_material.add(face.index)
            if uv is None or len(uv.data) != len(mesh.loops):
                missing.add(face.index)
        for tri in mesh.loop_triangles:
            points = [mesh.vertices[index].co for index in tri.vertices]
            area = (points[1] - points[0]).cross(points[2] - points[0]).length * .5
            if any(not math.isfinite(value) for point in points for value in point) or not math.isfinite(area):
                bad_geometry.add(tri.polygon_index)
                continue
            # Zero-area geometry is not a visible missing texture. Its separate
            # geometric repair is outside this coverage check.
            if area == 0:
                continue
            if tri.polygon_index in missing:
                invalid.add(tri.polygon_index)
                continue
            values = [tuple(uv.data[index].uv) for index in tri.loops]
            if any(not math.isfinite(value) for pair in values for value in pair):
                invalid.add(tri.polygon_index)
                continue
            a, b, c = values
            twice_area = abs((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]))
            if twice_area <= 1e-14:
                invalid.add(tri.polygon_index)
        if extension == '.blend' and any(mod.show_render for mod in obj.modifiers):
            # A provider upload will be FBX/GLB. Avoid certifying an unevaluated
            # native mesh as if modifiers were already exported.
            bad_geometry.update(face.index for face in mesh.polygons)
        item = {'name': obj.name, 'faces': len(mesh.polygons), 'triangles': len(mesh.loop_triangles),
                'uvMissing': len(missing), 'invalidUvFaces': len(invalid), 'invalidGeometryFaces': len(bad_geometry),
                'materialIndexIssues': len(bad_material), 'activeUv': active.name if active else None,
                'renderUv': render.name if render else None, 'consumedUv': consumed.name if consumed else None,
                'ambiguousUv': ambiguous, 'invalidFaceSample': sorted(invalid)[:30]}
        report['meshes'].append(item)
        for key in ('faces', 'triangles', 'invalidUvFaces', 'invalidGeometryFaces', 'materialIndexIssues'):
            report[key] += item[key]
        report['uvMissingFaces'] += item['uvMissing']
        report['ambiguousUvMeshes'] += int(ambiguous)
    if not report['faces'] or not report['triangles']:
        report['reasons'].append('검사할 메시 면이 없습니다.')
    report['uvMissing'] = report['uvMissingFaces'] > 0
    if report['uvMissing']:
        report['reasons'].append(f"UV가 없는 면 {report['uvMissingFaces']}개입니다. 먼저 UV를 준비하세요.")
    if report['invalidUvFaces']:
        report['reasons'].append(f"텍스처를 받을 UV 면적이 없는 면 {report['invalidUvFaces']}개입니다. 빠진 면의 UV를 보완하세요.")
    if report['materialIndexIssues']:
        report['reasons'].append(f"재질 연결이 잘못된 면 {report['materialIndexIssues']}개입니다.")
    if report['ambiguousUvMeshes']:
        report['reasons'].append('편집용·렌더용·업로드 기본 UV가 다릅니다. 사용할 UV를 하나로 확정한 내보내기 사본이 필요합니다.')
    if report['invalidGeometryFaces']:
        report['reasons'].append('비정상 좌표 또는 미확정 변형이 있어 업로드할 FBX/GLB를 먼저 확인해야 합니다.')
    report['ready'] = report['passed'] = not report['reasons']
    report['reason'] = ' '.join(report['reasons'])
    if file_hash(source) != q['sourceSha256']:
        raise RuntimeError('Frozen source changed during UV inspection')
    with pathlib.Path(q['report']).open('x', encoding='utf8') as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)


if __name__ == '__main__':
    inspect(json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf-8-sig')))

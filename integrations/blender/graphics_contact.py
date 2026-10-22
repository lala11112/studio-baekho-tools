"""Host-only static contact masks, exact preservation checks and review exports.

Semantic masks/camera directions are proposals requiring visual review. This
module proves preservation, never anatomy, clean joins or aesthetic quality.
"""
import bpy
import copy
import json
import math
import pathlib
import sys
from mathutils import Vector

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from graphics_astra_validate import (snapshot, repair_contract, assembly_snapshot,
    verify_assembly_parts, save_json, file_hash, digest)
from graphics_glb import export_packed_glb
import graphics_astra_validate as native

AXES = {'+X': (1, 0, 0), '-X': (-1, 0, 0), '+Y': (0, 1, 0), '-Y': (0, -1, 0)}
PROTECTED = ('face', 'ears', 'hairOuter', 'clothing', 'other')


def load(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))


def open_scene(file, expected=None):
    if expected and file_hash(file) != expected:
        raise RuntimeError('Contact source file hash mismatch')
    bpy.ops.wm.open_mainfile(filepath=str(file), load_ui=False, use_scripts=False)
    bpy.context.view_layer.update()


def bounds(points):
    if not points:
        raise RuntimeError('No geometry in contact view')
    return [[min(p[i] for p in points) for i in range(3)],
            [max(p[i] for p in points) for i in range(3)]]


def world_points(mesh_ids=None, indices=None):
    result = []
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH' and (mesh_ids is None or obj.get('partsmith_id') in mesh_ids):
            selected = indices.get(obj['partsmith_id']) if indices is not None else None
            result.extend(list(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices
                          if selected is None or vertex.index in selected)
    return result


def exact_contract():
    bpy.context.view_layer.update()
    def exact_numbers(values):
        result = [float(value) for value in values]
        if not all(math.isfinite(v) for v in result):
            raise RuntimeError('Non-finite contact evidence')
        return result
    rounded = native.numbers
    try:
        native.numbers = exact_numbers
        snap, exact = snapshot(), repair_contract()
    finally:
        native.numbers = rounded
    if snap['rigs'] or snap['actions'] or bpy.data.actions:
        raise RuntimeError('Contact editing supports static assemblies only')
    # Static repair contract is deliberately strict; positions are the only
    # field allowed to differ. Selection state is excluded by the shared helper.
    return {'snapshot': snap, 'exact': exact, 'assembly': assembly_snapshot()}


def normalize_builtin_attributes(mesh):
    result = copy.deepcopy(mesh)
    for name, kind, expected in (('material_index', 'INT', mesh['faceMaterials']),
                                 ('sharp_face', 'BOOLEAN', [not v for v in mesh['smooth']])):
        value = result['attributes'].pop(name, None)
        if value is not None and (value['domain'] != 'FACE' or value['type'] != kind or value['values'] != expected):
            raise RuntimeError('Built-in face attribute differs from native polygons')
        if value is None and any(expected):
            raise RuntimeError('Missing nondefault built-in face attribute')
    return result


def validate_proposal(proposal, baseline):
    """Return structurally verified masks. Semantics remain explicitly reviewed."""
    if proposal.get('schemaVersion') != 1 or proposal.get('sourceSha256') != baseline['sourceSha256']:
        raise RuntimeError('Analysis proposal source hash is stale or absent')
    if proposal.get('sourceVersionId') != baseline['sourceVersionId'] or proposal.get('partVersionIds') != baseline['partVersionIds']:
        raise RuntimeError('Analysis proposal source versions differ')
    if proposal.get('status') != 'ready':
        raise RuntimeError(str(proposal.get('reason') or 'Worker could not safely identify contact regions'))
    camera = proposal.get('camera', {})
    if camera.get('confidence') != 'confirmed' or camera.get('front') not in AXES or not isinstance(camera.get('evidence'), str) or not camera['evidence'].strip():
        raise RuntimeError('Front/side orientation remains uncertain; do not mislabel views')
    masks = proposal.get('meshes')
    source = baseline['contract']['exact']['meshes']
    if not isinstance(masks, list) or len(masks) != len(source) or len({m.get('meshId') for m in masks}) != len(source):
        raise RuntimeError('Contact masks must cover each original mesh exactly once')
    result, total = [], 0
    for mask in masks:
        key = mask.get('meshId')
        if key not in source or mask.get('topologySha256') != digest(source[key]['faces']):
            raise RuntimeError('Mask mesh identity/topology does not match source')
        expected_part = baseline['contract']['assembly']['meshes'][key]['partId']
        if mask.get('partId') != expected_part:
            raise RuntimeError('Mask part identity does not match source')
        count = len(source[key]['positions'])
        if mask.get('vertexCount') != count or mask.get('certainty') != 'confirmed' or not isinstance(mask.get('evidence'), str) or not mask['evidence'].strip():
            raise RuntimeError('Mask semantics are incomplete or uncertain')
        allowed, protected = mask.get('allowed'), mask.get('protected')
        if not isinstance(allowed, dict) or set(allowed) != {'neck', 'innerHair'} or not isinstance(protected, dict) or set(protected) != set(PROTECTED):
            raise RuntimeError('Every permitted and protected semantic region must be explicit')
        groups = {**allowed, **protected}
        seen = set()
        for name, ids in groups.items():
            if not isinstance(ids, list) or any(type(i) is not int or not 0 <= i < count for i in ids) or len(set(ids)) != len(ids) or seen.intersection(ids):
                raise RuntimeError('Contact masks overlap, contain duplicates or exceed source vertices')
            seen.update(ids)
        if seen != set(range(count)):
            raise RuntimeError('Every vertex must be allowed or explicitly protected')
        if expected_part not in ('head', 'body') and allowed['neck'] or expected_part != 'hair' and allowed['innerHair']:
            raise RuntimeError('Contact semantic region does not belong to the declared part')
        n = len(allowed['neck']) + len(allowed['innerHair'])
        if n > count * (0.65 if expected_part == 'hair' else 0.25):
            raise RuntimeError('Proposed contact region exceeds bounded local correction scope')
        # Exact protected complement is the invariant, not a mathematical claim
        # that the agent labelled face/ears/clothing correctly.
        total += n
        result.append(mask)
    if not total:
        raise RuntimeError('Analysis has no safe contact vertices to correct')
    return {'schemaVersion': 1, 'sourceSha256': baseline['sourceSha256'],
        'sourceVersionId': baseline['sourceVersionId'], 'partVersionIds': baseline['partVersionIds'],
        'baselineContractSha256': digest(baseline['contract']), 'camera': camera,
        'meshes': result, 'allowedVertexCount': total, 'semanticQualityVerified': False,
        'visualReviewRequired': True, 'maxDisplacementRule': 'min(5% part diagonal, 2% assembly diagonal)'}


def validate_repair(before, after, regions):
    if digest(before) != regions.get('baselineContractSha256'):
        raise RuntimeError('Frozen contact masks do not belong to this exact native baseline')
    a, b = before['exact'], after['exact']
    if a['objects'] != b['objects'] or a['actions'] != b['actions'] or set(a['meshes']) != set(b['meshes']):
        raise RuntimeError('Contact repair changed object IDs, transforms, hierarchy or dependencies')
    for field in ('materials', 'textures', 'rigs', 'actions'):
        if before['snapshot'][field] != after['snapshot'][field]:
            raise RuntimeError('Contact repair changed ' + field)
    masks = {m['meshId']: m for m in regions['meshes']}
    whole = bounds([p for m in before['assembly']['meshes'].values() for p in m['worldPositions']])
    total_moved, max_displacement = 0, 0.0
    for key, original in a['meshes'].items():
        result = b['meshes'][key]
        left, right = normalize_builtin_attributes(original), normalize_builtin_attributes(result)
        left.pop('positions'); right.pop('positions')
        if left != right or len(original['positions']) != len(result['positions']):
            raise RuntimeError('Contact repair changed topology, UV, material, weight or mesh attributes')
        allowed = set(masks[key]['allowed']['neck'] + masks[key]['allowed']['innerHair'])
        expected, actual = before['assembly']['meshes'][key], after['assembly']['meshes'][key]
        limit = min(math.dist(*expected['worldBounds']) * 0.05, math.dist(*whole) * 0.02)
        for index, point in enumerate(original['positions']):
            if result['positions'][index] == point:
                continue
            if index not in allowed:
                raise RuntimeError('Contact repair moved a protected vertex: ' + key + ':' + str(index))
            displacement = math.dist(expected['worldPositions'][index], actual['worldPositions'][index])
            if not math.isfinite(displacement) or displacement > limit:
                raise RuntimeError('Contact vertex displacement exceeds frozen local repair bound')
            total_moved += 1
            max_displacement = max(max_displacement, displacement)
    if total_moved == 0:
        raise RuntimeError('Contact repair saved no permitted vertex changes')
    return {'protectedVerticesExact': True, 'topologyExact': True, 'transformsExact': True,
        'uvMaterialsIdsExact': True, 'boundedDisplacement': True, 'movedVertices': total_moved,
        'maxWorldDisplacement': max_displacement, 'visualQualityVerified': False}


def render_views(source, output, camera=None, masks=None, framing=None, prefix='before'):
    """Temporary local render scene only; camera/framing saved for exact pairing."""
    open_scene(source)
    output = pathlib.Path(output); output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    for obj in list(scene.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj, do_unlink=True)
    whole = bounds(world_points())
    head_ids = {o['partsmith_id'] for o in scene.objects if o.type == 'MESH' and o.get('partsmith_part_id') in ('head', 'hair')}
    detail = bounds(world_points(head_ids)) if head_ids else whole
    hair_ids = {o['partsmith_id'] for o in scene.objects if o.type == 'MESH' and o.get('partsmith_part_id') == 'hair'}
    if framing is None:
        framing = {'whole': whole, 'contact': detail, 'neck-visible': detail,
                   'hair-inner': bounds(world_points(hair_ids)) if hair_ids else detail}
    original_visibility = {o.name: o.hide_render for o in scene.objects if o.type == 'MESH'}
    palette = {}
    for name, color in [('protected', (.55, .08, .10, 1)), ('neck', (0.04, .83, .55, 1)), ('innerHair', (.06, .70, .35, 1))]:
        mat = bpy.data.materials.new('ContactOverlay_' + name); mat.diffuse_color = color; palette[name] = mat
    if masks:
        mapping = {m['meshId']: m for m in masks['meshes']}
        for obj in scene.objects:
            if obj.type != 'MESH':
                continue
            mask = mapping[obj['partsmith_id']]
            neck, hair = set(mask['allowed']['neck']), set(mask['allowed']['innerHair'])
            colors = obj.data.color_attributes.new(name='ContactReviewOnly', type='FLOAT_COLOR', domain='CORNER')
            for loop in obj.data.loops:
                added = masks.get('schemaVersion') == 2 and loop.vertex_index >= mask['vertexCount']
                name = 'neck' if loop.vertex_index in neck or added and mask['partId'] == 'head' else 'innerHair' if loop.vertex_index in hair or added and mask['partId'] == 'hair' else 'protected'
                colors.data[loop.index].color = palette[name].diffuse_color
            obj.data.color_attributes.active_color = colors
    scene.render.engine = 'BLENDER_WORKBENCH'
    scene.display.shading.light = 'STUDIO'; scene.display.shading.studiolight_rotate_z = 0.0
    scene.display.shading.color_type = 'VERTEX' if masks else 'SINGLE'
    scene.display.shading.single_color = (.66, .69, .73)
    scene.display.shading.show_shadows = True; scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = 'BOTH'
    scene.display.shading.background_type = 'WORLD'
    scene.world = bpy.data.worlds.new('ContactReviewOnlyWorld'); scene.world.color = (.035, .045, .055)
    scene.render.resolution_x = scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100; scene.render.image_settings.file_format = 'PNG'
    cam = bpy.data.cameras.new('ContactReviewCamera'); cam.type = 'ORTHO'
    obj = bpy.data.objects.new(cam.name, cam); scene.collection.objects.link(obj); scene.camera = obj
    if camera and camera.get('confidence') == 'confirmed' and camera.get('front') in AXES:
        front = Vector(AXES[camera['front']]); side = Vector((-front.y, front.x, 0))
        directions = [('front', '정면', front), ('side', '측면', side), ('back', '후면', -front)]
    else:
        directions = [(axis.replace('+', 'pos').replace('-', 'neg'), axis + ' 방향 · 정면 미확인', Vector(offset)) for axis, offset in AXES.items()]
    views = []
    for detail_id, box in framing.items():
        for mesh in scene.objects:
            if mesh.type == 'MESH':
                mesh.hide_render = original_visibility[mesh.name] or (detail_id == 'neck-visible' and mesh.get('partsmith_part_id') == 'hair') or (detail_id == 'hair-inner' and mesh.get('partsmith_part_id') != 'hair')
        low, high = (Vector(p) for p in box); center = (low + high) / 2
        radius = max((high - low).length / 2, 0.01)
        cam.ortho_scale = radius * 2.3; cam.clip_start = .00001; cam.clip_end = radius * 100 + 100
        view_directions = [('inside-bottom', '헤어 안쪽 · 아래에서', Vector((0, 0, -1)))] if detail_id == 'hair-inner' else directions
        for axis, label, direction in view_directions:
            obj.location = center + direction * radius * 5
            obj.rotation_euler = (center - obj.location).to_track_quat('-Z', 'Y').to_euler()
            name = prefix + '-' + detail_id + '-' + axis + '.png'
            scene.render.filepath = str(output / name); bpy.ops.render.render(write_still=True)
            prefix_label = {'whole': '전체 ', 'contact': '목·헤어 확대 ', 'neck-visible': '헤어 숨김 · 얼굴·목 ', 'hair-inner': ''}[detail_id]
            views.append({'id': detail_id + '-' + axis, 'label': prefix_label + label, 'file': name})
    return views, framing


def prepare(q):
    open_scene(q['sourceBlend'], q['sourceSha256'])
    original = exact_contract()
    source_parts = {value['partId'] for value in original['assembly']['meshes'].values()}
    if source_parts != {'head', 'body', 'hair'}:
        raise RuntimeError('Contact validation requires exact head, body and hair parts')
    for part in q['partSources']:
        open_scene(part['path'], part['sha256'])
        expected = {key: m for key, m in original['assembly']['meshes'].items() if m['partId'] == part['slot'].removeprefix('part-')}
        if assembly_snapshot()['meshes'] != expected:
            raise RuntimeError('Placed part native geometry/placement differs from exact assembly candidate')
    baseline = {'schemaVersion': 1, 'identity': q['identity'], 'sourceVersionId': q['sourceVersionId'],
        'sourceSha256': q['sourceSha256'], 'partVersionIds': q['partVersionIds'], 'contract': original}
    save_json(q['report'], baseline)
    if q.get('render', True):
        views, framing = render_views(q['sourceBlend'], q['output'])
        save_json(q['previewReport'], {'views': views, 'framing': framing})


def analyze(q):
    baseline = load(q['baseline'])
    open_scene(q['sourceBlend'], baseline['sourceSha256'])
    if exact_contract() != baseline['contract']:
        raise RuntimeError('Analysis source baseline changed')
    error, regions = None, None
    try:
        regions = validate_proposal(load(q['proposal']), baseline)
    except (RuntimeError, KeyError, TypeError, ValueError) as issue:
        error = str(issue)
    if regions:
        save_json(q['regions'], regions)
    camera = regions['camera'] if regions else None
    views, framing = render_views(q['sourceBlend'], q['output'], camera)
    overlays = render_views(q['sourceBlend'], q['output'], camera, regions, framing, 'overlay')[0] if regions else []
    save_json(q['report'], {'schemaVersion': 1, 'identity': q['identity'], 'phase': 'analyze',
        'status': 'ready' if regions else 'blocked', 'sourceSha256': baseline['sourceSha256'],
        'sourceVersionId': baseline['sourceVersionId'], 'partVersionIds': baseline['partVersionIds'],
        'allowedVertexCount': regions['allowedVertexCount'] if regions else 0,
        'warnings': [error] if error else ['색으로 표시한 수정 영역의 외형 검토가 필요합니다. 의미 분류는 자동 보장하지 않습니다.'],
        'regions': pathlib.Path(q['regions']).name if regions else None, 'views': views, 'overlays': overlays,
        'framing': framing, 'files': [v['file'] for v in views + overlays] + ([pathlib.Path(q['regions']).name] if regions else []),
        'visualQualityVerified': False})


def export_scene(folder):
    folder = pathlib.Path(folder); folder.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    members = [obj for obj in bpy.context.scene.objects if obj.type in ('MESH', 'EMPTY')]
    for obj in members: obj.select_set(True)
    bpy.context.view_layer.objects.active = next(obj for obj in members if obj.type == 'MESH')
    # Preserve native polygons before the preview exporter performs triangulation.
    bpy.ops.export_scene.fbx(filepath=str(folder / 'asset.fbx'), use_selection=True,
        object_types={'MESH', 'EMPTY'}, axis_forward='-Z', axis_up='Y', apply_unit_scale=True,
        apply_scale_options='FBX_SCALE_UNITS', use_mesh_modifiers=False, use_triangles=False,
        use_custom_props=True, add_leaf_bones=False, bake_anim=False, path_mode='COPY', embed_textures=True)
    export_packed_glb(folder / 'asset.glb', use_selection=True, use_active_scene=True, export_animations=False, export_extras=True)
    return ['asset.fbx', 'asset.glb']


def repair(q):
    reconstruct = q.get('mode') == 'reconstruct'
    baseline, regions = load(q['baseline']), load(q['regions'])
    if file_hash(q['regions']) != q['regionsSha256']:
        raise RuntimeError('Frozen contact region file changed')
    # Revalidate the complete mask contract, not just a worker-supplied ready bit.
    if not reconstruct:
        proposal = {**regions, 'status': 'ready'}
        verified = validate_proposal(proposal, baseline)
        if verified != regions:
            raise RuntimeError('Frozen contact regions contain altered validation fields')
    open_scene(q['sourceBlend'], baseline['sourceSha256'])
    before = exact_contract()
    if before != baseline['contract']:
        raise RuntimeError('Repair baseline changed')
    output_hash = file_hash(q['outputBlend'])
    open_scene(q['outputBlend'])
    after = exact_contract()
    if reconstruct:
        from graphics_contact_reconstruct import validate_reconstruction
        checks = validate_reconstruction(before, after, regions)
    else:
        checks = validate_repair(before, after, regions)
    if q.get('validateOnly'):
        save_json(q['report'], {'passed': True, 'checks': checks}); return
    out = pathlib.Path(q['output']); out.mkdir(parents=True, exist_ok=True)
    (out / 'regions.json').write_bytes(pathlib.Path(q['regions']).read_bytes())
    main_files = export_scene(out)
    candidates = []
    # Reopen pristine authored output before each export so preview triangulation
    # cannot leak into native part .blend/.fbx or the next part.
    for part in ('head', 'body', 'hair'):
        open_scene(q['outputBlend'], output_hash)
        original_scene = bpy.context.scene
        scene = bpy.data.scenes.new('Contact_' + part)
        members = [obj for obj in original_scene.objects if obj.type == 'EMPTY' or obj.type == 'MESH' and obj.get('partsmith_part_id') == part]
        for obj in members:
            parent = obj.parent
            while parent:
                if parent not in members: raise RuntimeError('Part has an external parent dependency')
                parent = parent.parent
            scene.collection.objects.link(obj)
        bpy.context.window.scene = scene
        folder = out / ('part-' + part); folder.mkdir()
        bpy.data.libraries.write(str(folder / 'asset.blend'), {scene}, fake_user=True, compress=False)
        files = ['asset.blend', *export_scene(folder)]
        candidates.append({'slot': part, 'meshIds': [key for key, value in after['assembly']['meshes'].items() if value['partId'] == part],
            'files': ['part-' + part + '/' + file for file in files]})
    exports = verify_assembly_parts({'output': str(out)}, candidates, after['assembly'])
    for receipt in exports:
        receipt['operation'] = 'M06'; receipt['contactPhase'] = 'reconstruct' if reconstruct else 'repair'
        save_json(out / ('part-' + receipt['partId']) / 'report.json', receipt)
    for candidate in candidates:
        folder = out / ('part-' + candidate['slot'])
        points = [point for key in candidate['meshIds'] for point in after['assembly']['meshes'][key]['worldPositions']]
        part_views, _ = render_views(folder / 'asset.blend', folder, regions['camera'], framing={'whole': bounds(points)}, prefix='part')
        candidate['files'].extend('part-' + candidate['slot'] + '/' + view['file'] for view in part_views)
    before_views, framing = render_views(q['sourceBlend'], out, regions['camera'])
    after_views = render_views(q['outputBlend'], out, regions['camera'], framing=framing, prefix='after')[0]
    overlays = render_views(q['outputBlend'], out, regions['camera'], masks=regions, framing=framing, prefix='overlay')[0]
    if file_hash(q['sourceBlend']) != baseline['sourceSha256'] or file_hash(q['outputBlend']) != output_hash:
        raise RuntimeError('Read-only export changed native source or output')
    files = main_files + ['regions.json'] + [v['file'] for v in before_views + after_views + overlays] + [file for p in candidates for file in p['files']]
    warnings = ['몸통·보호 영역·기존 면과 UV 보존 검사를 통과했습니다. 목·헤어 변화와 추가 면은 전후 화면에서 검토하세요.',
        '헤어 외곽의 작은 변화가 허용된 보정입니다. 새 면의 UV·텍스처와 접합 외형은 아직 채택되지 않았습니다.'] if reconstruct else ['보호 영역·구조 보존 검사를 통과했습니다. 접합 품질은 전후 화면에서 검토하세요.']
    save_json(q['report'], {'schemaVersion': 1, 'identity': q['identity'], 'phase': 'reconstruct' if reconstruct else 'repair', 'status': 'repaired',
        'sourceSha256': baseline['sourceSha256'], 'outputSha256': output_hash, 'checks': checks, 'passed': True,
        'sourceVersionId': baseline['sourceVersionId'], 'partVersionIds': baseline['partVersionIds'],
        'allowedVertexCount': regions['allowedVertexCount'], 'warnings': warnings,
        'modifiedUVRequiresReview': bool(reconstruct and checks.get('addedFaces')),
        'mainFiles': main_files + ['regions.json'], 'regions': 'regions.json', 'candidates': candidates, 'views': before_views, 'afterViews': after_views, 'overlays': overlays,
        'framing': framing, 'files': files, 'nativePartExports': exports, 'visualQualityVerified': False})


if __name__ == '__main__':
    from graphics_contact_reconstruct import prepare_reconstruction
    from graphics_contact_compat import prepare_compatibility
    q = load(sys.argv[sys.argv.index('--') + 1])
    {'prepare': prepare, 'analyze': analyze, 'repair': repair,
     'reconstruction-scope': prepare_reconstruction, 'reconstruct': repair,
     'procedure-compat-prepare': prepare_compatibility}[q['mode']](q)

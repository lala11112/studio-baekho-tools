"""Local, frozen append-only contact reconstruction contract.

This is deliberately distinct from the unchanged fixed-topology repair. The
host derives its editable vertices before authoring; an author's output cannot
widen them. Numerical preservation does not prove anatomy or visual quality.
"""
import copy
import math
import pathlib
from mathutils import Vector
from mathutils.bvhtree import BVHTree

POLICY = 'contact-local-reconstruction-v1'


def module():
    import graphics_contact
    return graphics_contact


def checked_proposal(proposal, baseline):
    c = module()
    if proposal.get('schemaVersion') != 1 or proposal.get('sourceSha256') != baseline['sourceSha256']:
        raise RuntimeError('Reconstruction evidence source hash differs')
    if proposal.get('sourceVersionId') != baseline['sourceVersionId'] or proposal.get('partVersionIds') != baseline['partVersionIds']:
        raise RuntimeError('Reconstruction evidence versions differ')
    source = baseline['contract']['exact']['meshes']
    masks = proposal.get('meshes', [])
    if len(masks) != len(source) or {m.get('meshId') for m in masks} != set(source):
        raise RuntimeError('Reconstruction evidence must cover exact original meshes')
    for mask in masks:
        original = source[mask['meshId']]
        count = len(original['positions'])
        if mask.get('topologySha256') != c.digest(original['faces']) or mask.get('vertexCount') != count:
            raise RuntimeError('Reconstruction evidence topology differs')
        if mask.get('partId') != baseline['contract']['assembly']['meshes'][mask['meshId']]['partId']:
            raise RuntimeError('Reconstruction evidence part identity differs')
        allowed, protected = mask.get('allowed', {}), mask.get('protected', {})
        if set(allowed) != {'neck', 'innerHair'} or set(protected) != set(c.PROTECTED):
            raise RuntimeError('Reconstruction evidence requires complete semantic groups')
        seen = set()
        for ids in [*allowed.values(), *protected.values()]:
            if not isinstance(ids, list) or any(type(i) is not int or not 0 <= i < count for i in ids) or len(set(ids)) != len(ids) or seen.intersection(ids):
                raise RuntimeError('Reconstruction evidence masks overlap or contain invalid indices')
            seen.update(ids)
        if seen != set(range(count)):
            raise RuntimeError('Reconstruction evidence leaves unclassified vertices')
        if mask['partId'] == 'head' and (mask.get('certainty') != 'confirmed' or not str(mask.get('evidence', '')).strip() or allowed['innerHair'] or not allowed['neck'] or len(allowed['neck']) > count * .25):
            raise RuntimeError('Head neck evidence is not a confirmed conservative region')
    return {mask['meshId']: mask for mask in masks}


def build_scope(baseline, proposal, proposal_hash):
    c = module()
    masks = checked_proposal(proposal, baseline)
    original = baseline['contract']
    meshes = original['assembly']['meshes']
    if {v['partId'] for v in meshes.values()} != {'head', 'body', 'hair'}:
        raise RuntimeError('Reconstruction requires original head, body and hair')
    head_points, head_faces = [], []
    for key, mesh in meshes.items():
        if mesh['partId'] == 'head':
            offset = len(head_points)
            head_points.extend(mesh['worldPositions'])
            head_faces.extend([index + offset for index in face] for face in original['exact']['meshes'][key]['faces'])
    head_diagonal = math.dist(*c.bounds(head_points))
    whole_diagonal = math.dist(*c.bounds([p for m in meshes.values() for p in m['worldPositions']]))
    if head_diagonal <= 1e-9:
        raise RuntimeError('Head has no usable extent')
    tree = BVHTree.FromPolygons([Vector(p) for p in head_points], head_faces, all_triangles=False)
    result, total = [], 0
    for key, mesh in meshes.items():
        part = mesh['partId']; points = mesh['worldPositions']; count = len(points)
        diagonal = math.dist(*mesh['worldBounds'])
        limit = 0.0 if part == 'body' else min(diagonal * .05, whole_diagonal * .02) if part == 'head' else diagonal * .01
        if part == 'head':
            indices = sorted(masks[key]['allowed']['neck'])
        elif part == 'hair':
            indices = []
            for index, point in enumerate(points):
                hit = tree.find_nearest(Vector(point))
                if hit and hit[0] is not None and hit[3] <= head_diagonal * .03:
                    indices.append(index)
        else:
            indices = []
        selected = [points[index] for index in indices]
        # Hair must stay inside its original overall envelope. The proximity
        # tube additionally prevents a new broad cap passing through the skull.
        roi = c.bounds(selected) if selected else mesh['worldBounds']
        margin = limit if part == 'head' else 0.0
        roi = [[roi[0][axis] - margin for axis in range(3)], [roi[1][axis] + margin for axis in range(3)]]
        protected = {name: [] for name in c.PROTECTED}
        if part == 'head':
            protected = copy.deepcopy(masks[key]['protected'])
        else:
            protected['other'] = sorted(set(range(count)) - set(indices))
        total += len(indices)
        edge_counts = {}
        for face in original['exact']['meshes'][key]['faces']:
            for edge in edges_of(face):
                ordered = tuple(sorted(edge)); edge_counts[ordered] = edge_counts.get(ordered, 0) + 1
        attachment_edges = [list(edge) for edge, count_edges in edge_counts.items() if count_edges == 1 and set(edge) <= set(indices)]
        result.append({'meshId': key, 'partId': part, 'vertexCount': count,
            'topologySha256': c.digest(original['exact']['meshes'][key]['faces']),
            'allowed': {'neck': indices if part == 'head' else [], 'innerHair': indices if part == 'hair' else []},
            'protected': protected, 'maxWorldDisplacement': limit,
            'newGeometryWorldBounds': roi, 'newGeometryProximity': max(limit, diagonal * .01) if indices else 0,
            'maxNewEdgeLength': diagonal * .10 if indices else 0,
            'permittedOriginalBoundaryEdges': attachment_edges,
            'maxAddedVertices': 256 if indices else 0, 'maxAddedFaces': 512 if indices else 0})
    if not total:
        raise RuntimeError('No bounded reconstruction region is available')
    camera = proposal.get('camera', {})
    if camera.get('front') not in c.AXES or camera.get('confidence') != 'confirmed' or not str(camera.get('evidence', '')).strip():
        camera = None
    return {'schemaVersion': 2, 'policyVersion': POLICY, 'mode': 'append-only-reconstruction',
        'sourceSha256': baseline['sourceSha256'], 'sourceVersionId': baseline['sourceVersionId'],
        'partVersionIds': baseline['partVersionIds'], 'baselineContractSha256': c.digest(original),
        'proposalSha256': proposal_hash, 'camera': camera, 'meshes': result, 'allowedVertexCount': total,
        'hairContactDistance': head_diagonal * .03, 'hairOriginalMovementFraction': .01,
        'bodyExact': True, 'existingFacesAndUVExact': True, 'visualReviewRequired': True,
        'semanticQualityVerified': False, 'silhouetteExact': False,
        'modifiedUVRequiresReview': True,
        'warnings': ['몸통·의상·얼굴·귀는 보존합니다. 기존 목 후보와 머리 가까이의 헤어만 제한적으로 조절합니다.',
            '헤어는 기존 크기 대각선의 1% 이내로 움직일 수 있어 외곽이 조금 달라질 수 있습니다. 전후 검토가 필요합니다.',
            '기존 면·UV는 유지하고 접합부에 면을 추가할 수 있습니다. 새 면의 UV·재질 완성은 이번 작업에 포함하지 않습니다.']}


def prepare_reconstruction(q):
    c = module()
    baseline = c.load(q['baseline'])
    c.open_scene(q['sourceBlend'], baseline['sourceSha256'])
    if c.exact_contract() != baseline['contract']:
        raise RuntimeError('Reconstruction source differs from exact baseline')
    if c.file_hash(q['proposal']) != q['proposalSha256']:
        raise RuntimeError('Reconstruction prior proposal hash differs')
    scope = build_scope(baseline, c.load(q['proposal']), q['proposalSha256'])
    c.save_json(q['report'], scope)
    if q.get('output') and q.get('previewReport'):
        views, framing = c.render_views(q['sourceBlend'], q['output'], scope['camera'])
        overlays = c.render_views(q['sourceBlend'], q['output'], scope['camera'], scope, framing, 'overlay')[0]
        c.save_json(q['previewReport'], {'views': views, 'overlays': overlays, 'framing': framing,
            'allowedVertexCount': scope['allowedVertexCount'], 'warnings': scope['warnings']})


def edges_of(face):
    return [(face[index], face[(index + 1) % len(face)]) for index in range(len(face))]


def validate_added(before, after, original_world, actual_world, mask):
    """Append-only faces must attach to permitted old boundary edges, locally."""
    old_v, old_f, old_e = len(before['positions']), len(before['faces']), len(before['edges'])
    added_v, added_f = len(after['positions']) - old_v, len(after['faces']) - old_f
    if not 0 <= added_v <= mask['maxAddedVertices'] or not 0 <= added_f <= mask['maxAddedFaces']:
        raise RuntimeError('Reconstruction exceeds frozen added geometry budget')
    allowed = set(mask['allowed']['neck'] + mask['allowed']['innerHair'])
    original_edges = {}
    for face in before['faces']:
        for edge in edges_of(face): original_edges.setdefault(tuple(sorted(edge)), []).append(edge)
    boundary = {edge: directions[0] for edge, directions in original_edges.items() if len(directions) == 1 and set(edge) <= allowed}
    permitted_boundary_vertices = {index for edge in boundary for index in edge}
    permitted_points = [original_world[index] for index in allowed]
    low, high = mask['newGeometryWorldBounds']
    for point in actual_world[old_v:]:
        if any(point[axis] < low[axis] - 1e-8 or point[axis] > high[axis] + 1e-8 for axis in range(3)):
            raise RuntimeError('New reconstruction vertex is outside frozen local bounds')
        if not permitted_points or min(math.dist(point, old) for old in permitted_points) > mask['newGeometryProximity'] + 1e-8:
            raise RuntimeError('New reconstruction vertex is too far from the permitted original surface')
    signatures = {tuple(sorted(face)) for face in before['faces']}
    new_edges, used_vertices = {}, set()
    new_faces = after['faces'][old_f:]
    for index, face in enumerate(new_faces):
        signature = tuple(sorted(face))
        if not 3 <= len(face) <= 8 or len(set(face)) != len(face) or signature in signatures or any(type(v) is not int or not 0 <= v < len(actual_world) for v in face):
            raise RuntimeError('New reconstruction face has duplicate or invalid corners')
        signatures.add(signature)
        if any(v < old_v and v not in permitted_boundary_vertices for v in face):
            raise RuntimeError('New reconstruction face touches a protected or interior original vertex')
        points = [Vector(actual_world[v]) for v in face]
        area = sum((points[i] - points[0]).cross(points[i + 1] - points[0]).length / 2 for i in range(1, len(points) - 1))
        if not math.isfinite(area) or area <= 1e-16:
            raise RuntimeError('New reconstruction face is degenerate')
        used_vertices.update(face)
        for edge in edges_of(face):
            length = math.dist(actual_world[edge[0]], actual_world[edge[1]])
            if length <= 1e-10 or length > mask['maxNewEdgeLength'] + 1e-8:
                raise RuntimeError('New reconstruction edge exceeds its local length bound')
            new_edges.setdefault(tuple(sorted(edge)), []).append((index, edge))
    if used_vertices.intersection(range(old_v, len(actual_world))) != set(range(old_v, len(actual_world))):
        raise RuntimeError('Reconstruction added loose or unused vertices')
    if any(tuple(sorted(edge)) not in new_edges for edge in after['edges'][old_e:]):
        raise RuntimeError('Reconstruction added a loose edge')
    neighbors = [set() for _ in new_faces]; attached = set()
    for edge, entries in new_edges.items():
        previous = original_edges.get(edge, [])
        directions = previous + [entry[1] for entry in entries]
        if len(directions) > 2 or len(directions) == 2 and directions[0] != tuple(reversed(directions[1])):
            raise RuntimeError('New reconstruction attachment has non-manifold or inconsistent winding')
        if previous:
            if edge not in boundary or len(entries) != 1:
                raise RuntimeError('New reconstruction faces must attach at a permitted original boundary')
            attached.add(entries[0][0])
        if len(entries) == 2:
            a, b = entries[0][0], entries[1][0]; neighbors[a].add(b); neighbors[b].add(a)
    visited = set()
    for start in range(len(new_faces)):
        if start in visited: continue
        pending, component = [start], set()
        while pending:
            index = pending.pop()
            if index in component: continue
            component.add(index); pending.extend(neighbors[index] - component)
        if not component.intersection(attached):
            raise RuntimeError('Reconstruction has a detached new surface')
        visited.update(component)
    return added_v, added_f


def validate_reconstruction(before, after, scope):
    c = module()
    if scope.get('schemaVersion') != 2 or scope.get('policyVersion') != POLICY or scope.get('mode') != 'append-only-reconstruction' or c.digest(before) != scope.get('baselineContractSha256'):
        raise RuntimeError('Frozen reconstruction policy does not match the native baseline')
    a, b = before['exact'], after['exact']
    if a['objects'] != b['objects'] or a['actions'] != b['actions'] or set(a['meshes']) != set(b['meshes']):
        raise RuntimeError('Reconstruction changed object identities, transforms or hierarchy')
    for field in ('materials', 'textures', 'rigs', 'actions'):
        if before['snapshot'][field] != after['snapshot'][field]:
            raise RuntimeError('Reconstruction changed original ' + field)
    masks = {mask['meshId']: mask for mask in scope['meshes']}
    if set(masks) != set(a['meshes']):
        raise RuntimeError('Reconstruction policy has different mesh identities')
    total_moved = total_vertices = total_faces = 0; maximum = 0.0
    for key, original in a['meshes'].items():
        result, mask = b['meshes'][key], masks[key]
        if mask['partId'] != before['assembly']['meshes'][key]['partId'] or mask['vertexCount'] != len(original['positions']) or mask['topologySha256'] != c.digest(original['faces']):
            raise RuntimeError('Reconstruction frozen part topology differs')
        if mask['partId'] == 'body':
            if original != result or before['assembly']['meshes'][key] != after['assembly']['meshes'][key]:
                raise RuntimeError('Reconstruction changed the protected body or clothing')
            continue
        old_v, old_f, old_e = len(original['positions']), len(original['faces']), len(original['edges'])
        if len(result['positions']) < old_v or result['faces'][:old_f] != original['faces'] or result['edges'][:old_e] != original['edges']:
            raise RuntimeError('Reconstruction changed original topology or vertex indexing')
        for field in ('materials', 'activeUV', 'properties', 'groups'):
            if original[field] != result[field]: raise RuntimeError('Reconstruction changed original mesh ' + field)
        for field in ('faceMaterials', 'smooth'):
            if result[field][:old_f] != original[field]: raise RuntimeError('Reconstruction changed original face assignments')
        if any(type(index) is not int or not 0 <= index < max(1, len(original['materials'])) for index in result['faceMaterials'][old_f:]):
            raise RuntimeError('Reconstruction added an invalid material assignment')
        if result['weights'][:old_v] != original['weights'] or any(result['weights'][old_v:]):
            raise RuntimeError('Reconstruction changed original weights or added weighted vertices')
        if len(original['uv']) != len(result['uv']) or any(old[0] != new[0] or old[2] != new[2] or old[1] != new[1][:len(old[1])] for old, new in zip(original['uv'], result['uv'])):
            raise RuntimeError('Reconstruction changed original UV layers or corners')
        left, right = c.normalize_builtin_attributes(original)['attributes'], c.normalize_builtin_attributes(result)['attributes']
        if set(left) != set(right) or any(value['domain'] != right[name]['domain'] or value['type'] != right[name]['type'] or value['values'] != right[name]['values'][:len(value['values'])] for name, value in left.items()):
            raise RuntimeError('Reconstruction changed an original attribute or stable ID')
        allowed = set(mask['allowed']['neck'] + mask['allowed']['innerHair'])
        old_world, new_world = before['assembly']['meshes'][key]['worldPositions'], after['assembly']['meshes'][key]['worldPositions']
        for index, point in enumerate(original['positions']):
            if point == result['positions'][index]: continue
            if index not in allowed: raise RuntimeError('Reconstruction moved a protected original vertex')
            distance = math.dist(old_world[index], new_world[index])
            if distance > mask['maxWorldDisplacement'] + 1e-10:
                raise RuntimeError('Reconstruction movement exceeds frozen local displacement bound')
            total_moved += 1; maximum = max(maximum, distance)
        added_v, added_f = validate_added(original, result, old_world, new_world, mask)
        total_vertices += added_v; total_faces += added_f
    if total_moved + total_vertices + total_faces == 0:
        raise RuntimeError('Reconstruction contains no permitted changes')
    return {'protectedVerticesExact': True, 'originalTopologyExact': True, 'originalUvMaterialsIdsExact': True,
        'transformsExact': True, 'boundedDisplacement': True, 'addedGeometryLocalized': True, 'bodyExact': True,
        'movedVertices': total_moved, 'addedVertices': total_vertices, 'addedFaces': total_faces,
        'maxWorldDisplacement': maximum, 'silhouetteExact': False,
        'modifiedUVRequiresReview': bool(total_faces), 'visualQualityVerified': False}

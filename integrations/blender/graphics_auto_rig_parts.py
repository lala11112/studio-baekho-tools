"""Strict optional multipart contract for the app's local ARP worker.

Never discovers parts from names and never changes weights during inspection.
"""
import math
import bpy


def policy(value):
    if value is None:return None
    assert type(value) is dict and set(value)=={'schemaVersion','requiredParts','headBoundParts'} and type(value['schemaVersion']) is int and value['schemaVersion']==1,'Invalid frozen part policy'
    for key in ['requiredParts','headBoundParts']:
        values=value[key]
        assert type(values) is list and all(type(x) is str and x and not x.startswith('part-') for x in values) and values==sorted(set(values)),'Invalid frozen part IDs'
    assert value['requiredParts'] and set(value['headBoundParts']).issubset(value['requiredParts']),'Invalid frozen head-bound parts'
    return value


def identities(meshes,value):
    value=policy(value)
    if value is None:return {}
    result={};ids=set()
    for obj in meshes:
        mesh_id=obj.get('partsmith_id');part_id=obj.get('partsmith_part_id')
        assert type(mesh_id) is str and mesh_id and mesh_id not in ids,'Missing or duplicate immutable mesh ID'
        assert type(part_id) is str,'Missing explicit part ID'
        part_id=part_id.removeprefix('part-')
        assert part_id in value['requiredParts'],'Mesh part ID outside frozen policy'
        ids.add(mesh_id);result[mesh_id]=(obj,part_id)
    assert {p for _,p in result.values()}==set(value['requiredParts']),'Missing frozen requested part'
    return result


def head_binding(meshes,rig,value,apply=False):
    entries=identities(meshes,value)
    if not entries:return
    head=rig.data.bones.get('head.x')
    assert head and head.use_deform,'Actual deform Head bone unavailable'
    for obj,part in entries.values():
        if part not in value['headBoundParts']:continue
        if apply:
            for group in list(obj.vertex_groups):obj.vertex_groups.remove(group)
            obj.vertex_groups.new(name=head.name).add(list(range(len(obj.data.vertices))),1.0,'REPLACE')
        for vertex in obj.data.vertices:
            rows=[(obj.vertex_groups[g.group].name,g.weight) for g in vertex.groups if g.weight>1e-6]
            assert rows and all(name==head.name and math.isfinite(w) for name,w in rows) and abs(sum(w for _,w in rows)-1)<1e-6,'Frozen head-bound part has non-Head weights'


def snapshot(meshes,value):
    entries=identities(meshes,value)
    return {mesh_id:{'partId':part,'vertices':[tuple(obj.matrix_world@v.co) for v in obj.data.vertices],
        'faces':[tuple(p.vertices) for p in obj.data.polygons],
        'uv':{layer.name:[tuple(v.uv) for v in layer.data] for layer in obj.data.uv_layers},
        'materials':[m.name if m else None for m in obj.data.materials],
        'assignments':[p.material_index for p in obj.data.polygons]} for mesh_id,(obj,part) in entries.items()}


def verify_export(meshes,rig,value,expected):
    actual=snapshot(meshes,value)
    assert set(actual)==set(expected),'Exported immutable mesh IDs changed'
    for mesh_id,source in expected.items():
        target=actual[mesh_id]
        assert target['partId']==source['partId'] and len(target['vertices'])==len(source['vertices']),'Exported part identity or vertex count changed'
        assert target['faces']==source['faces'],'Exported part topology/order changed'
        assert target['materials']==source['materials'] and target['assignments']==source['assignments'],'Exported part material slots or assignments changed'
        assert set(target['uv'])==set(source['uv']),'Exported UV layer names changed'
        for name,rows in source['uv'].items():
            assert len(target['uv'][name])==len(rows) and all(abs(a-b)<=1e-6 for row,other in zip(rows,target['uv'][name]) for a,b in zip(row,other)),'Exported UV corners changed'
        assert all(max(abs(a-b) for a,b in zip(row,other))<=1e-5 for row,other in zip(source['vertices'],target['vertices'])),'Exported part world geometry changed'
    head_binding(meshes,rig,value)
    return [{'partId':part,'meshIds':sorted(mesh_id for mesh_id,item in actual.items() if item['partId']==part),'present':True,'headBound':part in value['headBoundParts']} for part in value['requiredParts']]

import bpy, pathlib, os, sys, json, runpy
repo=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo/'integrations/blender'))
import graphics_planar_repair as p
root=pathlib.Path(os.environ['A05_FBX_AUDIT_ROOT']);root.mkdir(parents=True,exist_ok=True)
source=pathlib.Path(os.environ['A05_FBX_AUDIT_SOURCE'])
old_fbx=source.with_suffix('.fbx')
originals={str(f):p.file_hash(f) for f in (source,old_fbx)}
checks=[]
bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False,use_scripts=False)
source_hierarchy=p.hierarchy_snapshot(list(bpy.context.scene.objects))
out=root/'fresh-x04';out.mkdir()
request=root/'request.json';request.write_text(json.dumps({'source':str(source),'sourceSha256':originals[str(source)],'output':str(out),'identity':'qa-own-fbx-roundtrip','operation':'X04','scale':1,'pivot':'keep','format':'fbx'}))
sys.argv=['worker','--',str(request)]
runpy.run_path(str(repo/'integrations/blender/graphics_local.py'),run_name='__main__')
bpy.ops.wm.open_mainfile(filepath=str(out/'asset.blend'),load_ui=False,use_scripts=False)
assert p.hierarchy_snapshot(list(bpy.context.scene.objects))==source_hierarchy
checks.append('X04 editable hierarchy and custom properties unchanged')
q={'source':str(out/'asset.fbx'),'sourceSha256':p.file_hash(out/'asset.fbx'),'sourceVersionId':'fresh-own-fbx','identity':'qa-fbx-planar','algorithmVersion':'planar-v2','mode':'inspect','report':str(root/'inspect.json')}
objects=p.load(q);baseline=p.hierarchy_snapshot(list(bpy.context.scene.objects))
wrapper=bpy.data.objects['Partsmith_SizeRoot']
assert type(wrapper.get(p.SIZE_ROOT_MARKER)) is int and wrapper[p.SIZE_ROOT_MARKER]==1
assert all(o.parent==wrapper for o in objects)
assert bpy.data.objects['OpenBox']['partsmith_id']=='open-box'
assert bpy.data.objects['OpenBox']['qa_custom']=='preserve'
assert bpy.data.objects['Unchanged']['qa_custom']=='unchanged'
unchanged=p.mesh_snapshot(bpy.data.objects['Unchanged'])
checks.append('actual own FBX retains serialized boolean marker int1 and all mesh IDs/properties')
residual=max(abs(wrapper.matrix_world[i][j]) for i in range(3) for j in range(3) if i!=j)
assert residual>1e-8
r=p.run(q);record=next(m for m in r['meshes'] if m['name']=='OpenBox');boundary=next(b for b in record['boundaries'] if b['status']=='eligible')
checks.append('actual FP32 FBX root inspects without rewriting transforms')
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=record['meshId'],selectedBoundaryIds=[boundary['id']],keptBoundaryIds=[],materialPolicy='preserve',output=str(root/'repair'),report=str(root/'repair-report.json'))
report=p.run(q);assert len(report['checks'])==12 and all(report['checks'].values())
bpy.ops.wm.open_mainfile(filepath=str(root/'repair/asset.blend'),load_ui=False,use_scripts=False)
assert p.hierarchy_snapshot(list(bpy.context.scene.objects))==baseline
assert p.mesh_snapshot(bpy.data.objects['Unchanged'])==unchanged
assert len(bpy.data.objects['OpenBox'].data.polygons)==6
checks.append('one quad only; all twelve checks; raw imported hierarchy/TRS/properties and unchanged mesh exact')
points=[o.matrix_world@v.co for o in bpy.context.scene.objects if o.type=='MESH' for v in o.data.vertices]
assert abs(max(v.x for v in points)-min(v.x for v in points)-2.5)<1e-5
assert abs(min(v.z for v in points))<1e-5
checks.append('world width2.5 and bottom pivot preserved')
reopened=dict(q,source=str(root/'repair/asset.blend'),sourceSha256=p.file_hash(root/'repair/asset.blend'),mode='inspect',report=str(root/'repaired-blend-inspect.json'))
p.run(reopened)
assert p.hierarchy_snapshot(list(bpy.context.scene.objects))==baseline
checks.append('repaired editable BLEND reinspection retains raw serialized int1 marker and exact TRS')

# Probe the validation boundary directly, without normalizing any source object.
def probe(label,scale,angle=0,spread=0,allowed=True,marked=True):
    objects=p.load(dict(q,mode='inspect'));r=bpy.data.objects['Partsmith_SizeRoot']
    r.scale=(scale,scale*(1+spread),scale);r.rotation_euler=(0,0,angle)
    if not marked:del r[p.SIZE_ROOT_MARKER]
    bpy.context.view_layer.update();before=p.hierarchy_snapshot(list(bpy.context.scene.objects))
    try:p.static_scene_meshes(list(bpy.context.scene.objects))
    except ValueError:
        assert not allowed,label
    else:assert allowed,label
    assert p.hierarchy_snapshot(list(bpy.context.scene.objects))==before
    checks.append(label)
tol=p.SIZE_ROOT_LINEAR_REL_TOLERANCE
for scale in (1e-9,1,1e6):
    probe('rotation just below relative bound '+str(scale),scale,angle=tol*.99)
    probe('rotation just above relative bound '+str(scale),scale,angle=tol*1.01,allowed=False)
    probe('meaningful rotation blocked at scale '+str(scale),scale,angle=.001,allowed=False)
probe('uniform FP32 spread below bound',1,spread=tol*.75)
probe('nonuniform nearest FP32 spread above bound blocked',1,spread=tol*1.25,allowed=False)
probe('nonuniform real scale blocked',1,spread=.01,allowed=False)
probe('unmarked root still blocked',1,allowed=False,marked=False)
probe('reflection still blocked',-1,allowed=False)
for value in (0,2,1.0,'1',False):
    p.load(dict(q,mode='inspect'));r=bpy.data.objects['Partsmith_SizeRoot'];r[p.SIZE_ROOT_MARKER]=value
    assert type(r[p.SIZE_ROOT_MARKER]) is type(value)
    try:p.static_scene_meshes(list(bpy.context.scene.objects))
    except ValueError:checks.append('invalid marker '+repr(value)+' '+type(value).__name__+' blocked')
    else:raise AssertionError('invalid marker accepted: '+repr(value))
assert all(p.file_hash(pathlib.Path(f))==sha for f,sha in originals.items())
checks.append('old source BLEND and FBX exact')
(root/'evidence.json').write_text(json.dumps({'status':'PASS','root':str(root),'sourceOriginals':originals,'freshFbx':str(out/'asset.fbx'),'repaired':str(root/'repair/asset.blend'),'relativeTolerance':tol,'measuredOffDiagonal':residual,'checks':checks,'modelTurns':0,'paidSubmissions':0},indent=2))

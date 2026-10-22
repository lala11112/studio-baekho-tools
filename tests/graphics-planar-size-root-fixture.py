import bpy, pathlib, os, sys, json, runpy, math
from mathutils import Matrix
repo=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'integrations/blender'))
import graphics_planar_repair as p
root=pathlib.Path(os.environ['PLANAR_SIZE_ROOT']);root.mkdir(parents=True,exist_ok=True);checks=[]
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('OpenBox');mesh.from_pydata([(x,y,z) for z in (0,1) for x,y in ((0,0),(1,0),(1,1),(0,1))],[],[(3,2,1,0),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);mesh.update();obj=bpy.data.objects.new('OpenBox',mesh);bpy.context.collection.objects.link(obj);obj['partsmith_id']='open-box';obj['qa_custom']='preserve';obj.location=(2,3,4)
# A separate unchanged mesh exercises hierarchy preservation outside the selected repair.
othermesh=bpy.data.meshes.new('Unchanged');othermesh.from_pydata([(4,0,0),(5,0,0),(5,1,0),(4,1,0)],[],[(0,1,2,3)]);othermesh.update();other=bpy.data.objects.new('Unchanged',othermesh);bpy.context.collection.objects.link(other);uv=othermesh.uv_layers.new(name='OriginalUV');uv.active_render=True
for li,coord in enumerate([(0,0),(1,0),(1,1),(0,1)]):uv.data[li].uv=coord
other['qa_custom']='unchanged';source=root/'open-box.blend';bpy.ops.wm.save_as_mainfile(filepath=str(source),compress=False);source_sha=p.file_hash(source)
out=root/'a05';out.mkdir();spec={'source':str(source),'sourceSha256':source_sha,'output':str(out),'identity':'size-root-tiny','operation':'A05','scale':1,'pivot':'keep','format':'both','physicalSize':{'mode':'uniform','axis':'x','lengthMeters':2.5,'dimensionsMeters':{'x':1,'y':1,'z':1},'pivot':'bottom-center'}}
request=root/'a05-request.json';request.write_text(json.dumps(spec));sys.argv=['worker','--',str(request)];runpy.run_path(str(repo/'integrations/blender/graphics_local.py'),run_name='__main__')
scaled=out/'asset.blend';bpy.ops.wm.open_mainfile(filepath=str(scaled),load_ui=False,use_scripts=False);baseline=p.hierarchy_snapshot(list(bpy.context.scene.objects));unchanged=p.mesh_snapshot(bpy.data.objects['Unchanged']);checks.append('actual A05 uniform wrapper generated')
q={'source':str(scaled),'sourceSha256':p.file_hash(scaled),'sourceVersionId':'tiny-a05','identity':'planar-size-root','algorithmVersion':'planar-v2','mode':'inspect','report':str(root/'inspect.json')};r=p.run(q);record=next(m for m in r['meshes'] if m['name']=='OpenBox');bs=record['boundaries'];assert len(bs)==1 and bs[0]['status']=='eligible',bs;checks.append('A05 direct mesh inspection eligible')
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=record['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[],materialPolicy='preserve',output=str(root/'repair'),report=str(root/'repair-report.json'));report=p.run(q);assert len(report['checks'])==12 and all(report['checks'].values());checks.append('existing twelve preservation/export checks pass')
bpy.ops.wm.open_mainfile(filepath=str(root/'repair/asset.blend'),load_ui=False,use_scripts=False);assert p.hierarchy_snapshot(list(bpy.context.scene.objects))==baseline;assert p.mesh_snapshot(bpy.data.objects['Unchanged'])==unchanged;checks.append('root and ALL mesh local hierarchy TRS inverse props exact')
def bounds():
    points=[o.matrix_world@v.co for o in bpy.context.scene.objects if o.type=='MESH' for v in o.data.vertices]
    return {'min':[min(v[i] for v in points) for i in range(3)],'max':[max(v[i] for v in points) for i in range(3)]}
for label,file in [('blend',root/'repair/asset.blend'),('fbx',root/'repair/asset.fbx'),('glb',root/'repair/asset.glb')]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if label=='blend':bpy.ops.wm.open_mainfile(filepath=str(file),load_ui=False,use_scripts=False)
    elif label=='fbx':bpy.ops.import_scene.fbx(filepath=str(file),use_image_search=False)
    else:bpy.ops.import_scene.gltf(filepath=str(file))
    b=bounds();assert abs(b['max'][0]-b['min'][0]-2.5)<1e-5 and abs(b['min'][2])<1e-5,b;checks.append(label+' world width2.5/bottom0')
# Rejections are load-only. Each mutation starts from the same accepted structural fixture.
def rejected(label,mutate):
    bpy.ops.wm.open_mainfile(filepath=str(scaled),load_ui=False,use_scripts=False);mutate(bpy.data.objects['Partsmith_SizeRoot'],bpy.data.objects['OpenBox']);f=root/(label+'.blend');bpy.ops.wm.save_as_mainfile(filepath=str(f),compress=False);bad=dict(q,source=str(f),sourceSha256=p.file_hash(f),mode='inspect',report=str(root/(label+'.json')))
    try:p.run(bad)
    except ValueError:checks.append(label+' rejected')
    else:raise AssertionError(label+' unexpectedly accepted')
rejected('unmarked',lambda r,o:r.__delitem__(p.SIZE_ROOT_MARKER))
rejected('nonuniform',lambda r,o:setattr(r,'scale',(1,2,1)))
rejected('negative',lambda r,o:setattr(r,'scale',(-1,-1,-1)))
rejected('rotated',lambda r,o:setattr(r,'rotation_euler',(0,0,.2)))
rejected('constraint',lambda r,o:r.constraints.new('COPY_LOCATION'))
rejected('instancing',lambda r,o:setattr(r,'instance_type','COLLECTION'))
rejected('animated',lambda r,o:r.keyframe_insert(data_path='location',frame=1))
def chain(r,o):
    e=bpy.data.objects.new('Intermediate',None);bpy.context.collection.objects.link(e);e.parent=r;o.parent=e
rejected('chain',chain)
assert p.file_hash(source)==source_sha;checks.append('original source exact')
(root/'evidence.json').write_text(json.dumps({'status':'PASS','root':str(root),'source':str(scaled),'repaired':str(root/'repair/asset.blend'),'checks':checks,'modelTurns':0,'paidSubmissions':0},indent=2))

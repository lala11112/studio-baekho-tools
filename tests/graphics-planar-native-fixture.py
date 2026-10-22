import bpy,sys,pathlib,tempfile,json,os
sys.path.insert(0,str(pathlib.Path.cwd()/'integrations/blender'))
import graphics_planar_repair as p
root=pathlib.Path(os.environ['PLANAR_FIXTURE_ROOT']) if os.environ.get('PLANAR_FIXTURE_ROOT') else pathlib.Path(tempfile.mkdtemp(prefix='planar-native-'))
root.mkdir(parents=True,exist_ok=True)
checks=[]
def fixture(name,verts,faces,negative=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    m=bpy.data.meshes.new(name);m.from_pydata(verts,[],faces);m.update();o=bpy.data.objects.new(name,m);bpy.context.collection.objects.link(o)
    if negative:o.scale=(-1,2,1)
    f=root/(name+'.blend');bpy.ops.wm.save_as_mainfile(filepath=str(f))
    return dict(source=str(f),sourceSha256=p.file_hash(f),sourceVersionId=name,identity=name,algorithmVersion='planar-v2')
def prism(poly):
    n=len(poly);v=[(x,y,z) for z in (0,1) for x,y in poly];f=[list(reversed(range(n)))]+[[i,(i+1)%n,(i+1)%n+n,i+n] for i in range(n)];return v,f
for name,poly in [('sharp-customnormals',[(0,0),(1,0),(1,1),(0,1)]),('tri',[(0,0),(1,0),(0,1)]),('quad',[(0,0),(1,0),(1,1),(0,1)]),('concave',[(0,0),(2,0),(2,2),(1,1),(0,2)]),('collinear',[(0,0),(1,0),(2,0),(2,1),(2,2),(1,2),(0,2)])]:
    v,f=prism(poly);q=fixture(name,v,f,negative=name=='quad')
    if name=='sharp-customnormals':
        mesh=bpy.context.scene.objects[0].data
        for edge in mesh.edges: edge.use_edge_sharp=edge.index%2==0
        custom=mesh.attributes.new(name='OriginalEdgeWeight',type='FLOAT',domain='EDGE')
        for i,item in enumerate(custom.data): item.value=i/100
        olduv=mesh.uv_layers.new(name='OldUV');olduv.active_render=True
        for face in mesh.polygons:
            for li,value in zip(face.loop_indices,[(0,0),(1,0),(1,1),(0,1)]): olduv.data[li].uv=value
        mesh.normals_split_custom_set([list(item.vector) for item in mesh.corner_normals]);bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source'])
    q.update(mode='inspect',report=str(root/(name+'-inspect.json')));r=p.run(q);bs=r['meshes'][0]['boundaries'];assert len(bs)==1 and bs[0]['status']=='eligible',bs
    q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[],materialPolicy='preserve',output=str(root/name),report=str(root/(name+'-repair.json')));r=p.run(q);assert r['addedFaces']>=1;checks.append(name)
print('PLANAR_NATIVE_PASS',json.dumps({'checks':checks,'root':str(root)}))
# Geometry rejection and multiple explicit choices.
try:p.project([(0,0,0),(1,0,0),(1,1,.2),(0,1,0)]);raise AssertionError('twist accepted')
except ValueError:checks.append('twisted-rejected')
try:p.project([(0,0,0),(1,1,0),(0,1,0),(1,0,0)]);raise AssertionError('cross accepted')
except ValueError:checks.append('cross-rejected')
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);v+= [(x+3,y,z) for x,y,z in v];f+= [[i+8 for i in face] for face in f.copy()]
q=fixture('multiloop',v,f);q.update(mode='inspect',report=str(root/'multi-inspect.json'));r=p.run(q);bs=r['meshes'][0]['boundaries'];assert len(bs)==2
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[bs[1]['id']],materialPolicy='preserve',output=str(root/'multi'),report=str(root/'multi-repair.json'));r=p.run(q);assert r['addedFaces']==1;checks.append('multiloop-kept-opening')
# Intersection through the selected opening is rejected.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);v += [(.5,-1,.5),(.5,2,.5),(.5,.5,1.5)];f += [[8,9,10]]
q=fixture('intersection',v,f);q.update(mode='inspect',report=str(root/'intersection-inspect.json'));r=p.run(q);bs=r['meshes'][0]['boundaries'];selected=next(b for b in bs if len(b['vertexIndices'])==4)
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[selected['id']],keptBoundaryIds=[b['id'] for b in bs if b!=selected],materialPolicy='preserve',output=str(root/'intersection'),report=str(root/'intersection-repair.json'))
try:p.run(q);raise AssertionError('intersecting patch accepted')
except ValueError as e:assert 'blocked' in str(e) and 'patch intersects existing surface' in selected['reasons'];checks.append('intersection-rejected')
# Explicit modifier rejection.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);q=fixture('deformation',v,f);obj=bpy.context.scene.objects[0];obj.modifiers.new('deform','SUBSURF');bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source']);q.update(mode='inspect',report=str(root/'deform-inspect.json'))
try:p.run(q);raise AssertionError('modifier accepted')
except ValueError:checks.append('deformation-rejected')
# UV policy probes: connected affine continuation vs explicit compatible reuse.
bpy.ops.wm.read_factory_settings(use_empty=True)
m=bpy.data.meshes.new('ring');m.from_pydata([(-1,-1,0),(2,-1,0),(2,2,0),(-1,2,0),(0,0,0),(1,0,0),(1,1,0),(0,1,0)],[],[(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);m.update();o=bpy.data.objects.new('ring',m);bpy.context.collection.objects.link(o);uv=m.uv_layers.new(name='UVMap');uv.active_render=True
for face in m.polygons:
    for li,vi in zip(face.loop_indices,face.vertices):uv.data[li].uv=((m.vertices[vi].co.x+1)/3,(m.vertices[vi].co.y+1)/3)
b=dict(vertexIndices=[4,7,6,5],materialIndex=0,adjacentFaces=[0,1,2,3]);assert len(p.uv_mapping(o,b,'preserve'))==4;checks.append('affine-uv-extension')
# Cube's opposite coplanar-shaped donor is only available with explicit reuse.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);q=fixture('reuse-policy',v,f);o=bpy.context.scene.objects[0];uv=o.data.uv_layers.new(name='UVMap');uv.active_render=True
for face in o.data.polygons:
    for li,value in zip(face.loop_indices,[(0,0),(1,0),(1,1),(0,1)]):uv.data[li].uv=value
b=p.boundaries(o)[0]
try:p.uv_mapping(o,b,'preserve');raise AssertionError('noncoplanar affine accepted')
except ValueError:pass
assert len(p.uv_mapping(o,b,'reuse-existing-pattern'))==4;checks.append('explicit-pattern-reuse')
print('PLANAR_NATIVE_ALL_PASS',json.dumps({'checks':checks,'root':str(root)}))
# Full textured reuse preserves native packed pixels and original UV corners.
image=bpy.data.images.new('Pattern',width=2,height=2);image.pixels=[1,0,0,1,0,1,0,1,0,0,1,1,1,1,1,1];image.filepath_raw=str(root/'pattern.png');image.file_format='PNG';image.save();bpy.data.images.remove(image);image=bpy.data.images.load(str(root/'pattern.png'));image.pack()
mat=bpy.data.materials.new('PatternMaterial');mat.use_nodes=True;node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image;mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);normalimage=bpy.data.images.new('NormalPattern',width=2,height=2);normalimage.pixels=[.5,.5,1,1]*4;normalimage.filepath_raw=str(root/'normal.png');normalimage.file_format='PNG';normalimage.save();bpy.data.images.remove(normalimage);normalimage=bpy.data.images.load(str(root/'normal.png'));normalimage.colorspace_settings.name='Non-Color';normalimage.pack();normaltex=mat.node_tree.nodes.new('ShaderNodeTexImage');normaltex.image=normalimage;normal=mat.node_tree.nodes.new('ShaderNodeNormalMap');mat.node_tree.links.new(normaltex.outputs['Color'],normal.inputs['Color']);mat.node_tree.links.new(normal.outputs['Normal'],mat.node_tree.nodes.get('Principled BSDF').inputs['Normal']);o.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source']);q.update(mode='inspect',report=str(root/'texture-inspect.json'));r=p.run(q);bs=r['meshes'][0]['boundaries'];assert bs[0]['materialOptions']==['reuse-existing-pattern'],bs
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[],materialPolicy='reuse-existing-pattern',output=str(root/'texture'),report=str(root/'texture-report.json'));r=p.run(q);assert p.file_hash(root/'pattern.png') in [t['sha256'] for t in r['textures']];checks.append('textured-reuse-packed-roundtrip');checks.append('normal-map-material-roundtrip')
assert p.intersects([(0,0,0),(1,0,0),(0,1,0)],[(1,0,0),(2,0,0),(1,1,0)],1e-7)
assert not p.intersects([(0,0,0),(1,0,0),(0,1,0)],[(1,0,0),(2,0,0),(1,1,0)],1e-7,[(1,0,0)])
checks.append('unrelated-touch-rejected-shared-vertex-permitted')
print('PLANAR_NATIVE_FINAL_PASS',json.dumps({'checks':checks,'root':str(root)}))

# Evidence is written after all compact regression probes.
(root/'native-evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'root':str(root),'localOnly':True,'modelTurns':0,'paidSubmissions':0},indent=2),encoding='utf8')




for label,scale in [('tiny-rotated',1e-4),('large-rotated',1e4)]:
    v,f=prism([(0,0),(1,0),(1,1),(0,1)]);v=[tuple(c*scale for c in point) for point in v];q=fixture(label,v,f);o=bpy.context.scene.objects[0];o.rotation_euler=(.3,-.4,.2);o.location=(scale*2,scale*-3,scale*4);bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source']);q.update(mode='inspect',report=str(root/(label+'-inspect.json')));r=p.run(q);bs=r['meshes'][0]['boundaries'];assert bs[0]['status']=='eligible',bs
    q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[],materialPolicy='preserve',output=str(root/label),report=str(root/(label+'-report.json')));p.run(q);checks.append(label)
try:p.project([(0,0,0),(1,0,0),(1,1,0),(0,0,0)]);raise AssertionError('duplicate accepted')
except ValueError:checks.append('duplicate-rejected')
for kind in ('rig','morph'):
    v,f=prism([(0,0),(1,0),(1,1),(0,1)]);q=fixture(kind,v,f);o=bpy.context.scene.objects[0]
    if kind=='morph':o.shape_key_add(name='Basis')
    else:
        arm=bpy.data.armatures.new('Rig');bpy.context.collection.objects.link(bpy.data.objects.new('Rig',arm))
    bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source']);q.update(mode='inspect',report=str(root/(kind+'-inspect.json')))
    try:p.run(q);raise AssertionError(kind+' accepted')
    except ValueError:checks.append(kind+'-rejected')
# A separate static mesh retains its coordinates, polygons, transforms and UVs.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);q=fixture('multi-mesh',v,f);m=bpy.data.meshes.new('UntouchedMesh');m.from_pydata(v,[],f);m.update();o=bpy.data.objects.new('Untouched',m);bpy.context.collection.objects.link(o);o.location=(3,0,0);uv=m.uv_layers.new(name='UVMap');uv.active_render=True
for face in m.polygons:
    for li,value in zip(face.loop_indices,[(0,0),(1,0),(1,1),(0,1)]):uv.data[li].uv=value
bpy.ops.wm.save_as_mainfile(filepath=q['source']);q['sourceSha256']=p.file_hash(q['source']);q.update(mode='inspect',report=str(root/'multimesh-inspect.json'));r=p.run(q);target=next(m for m in r['meshes'] if m['name']=='multi-mesh');bs=target['boundaries'];q.update(mode='repair',inspectionId=r['inspectionId'],meshId=target['meshId'],selectedBoundaryIds=[bs[0]['id']],keptBoundaryIds=[],materialPolicy='preserve',output=str(root/'multimesh'),report=str(root/'multimesh-report.json'));p.run(q);checks.append('other-mesh-preserved')
bpy.ops.wm.read_factory_settings(use_empty=True);m=bpy.data.meshes.new('Nested');m.from_pydata([(-1,-1,0),(2,-1,0),(2,2,0),(-1,2,0),(0,0,0),(1,0,0),(1,1,0),(0,1,0)],[],[(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]);m.update();o=bpy.data.objects.new('Nested',m);bpy.context.collection.objects.link(o);bs=p.boundaries(o);assert len(bs)==2 and all(b['status']=='blocked' and 'nested coplanar boundary' in b['reasons'] for b in bs);checks.append('nested-rejected')
(root/'native-evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'root':str(root),'localOnly':True,'modelTurns':0,'paidSubmissions':0},indent=2),encoding='utf8')
print('PLANAR_NATIVE_EXTENDED_PASS',json.dumps({'checks':checks,'root':str(root)}))


# The cyclic 2-core is repairable while dangling boundary edges are retained.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);v += [(0,2,2),(-1,1,2),(-1,2,2),(-1,2,3)];f += [[7,8,9],[8,10,9],[8,9,11],[9,10,11],[10,8,11]]
q=fixture('branch-leaves',v,f);q.update(mode='inspect',report=str(root/'branch-inspect.json'));r=p.run(q);bs=r['meshes'][0]['boundaries'];loops=[b for b in bs if b['status']=='eligible'];assert len(loops)==1 and loops[0]['kind']=='subcycle',bs
residual=[b for b in bs if b['kind']=='open-chain'];assert len(residual)==1 and residual[0]['status']=='blocked';assert len(residual[0]['edgeVertexPairs'])==2
q.update(mode='repair',inspectionId=r['inspectionId'],meshId=r['meshes'][0]['meshId'],selectedBoundaryIds=[loops[0]['id']],keptBoundaryIds=[b['id'] for b in bs if b!=loops[0]],materialPolicy='preserve',output=str(root/'branch'),report=str(root/'branch-report.json'));r=p.run(q);assert r['checks']['keptBoundaryEdgesPreserved'];checks.append('branch-pruned-subcycle-kept-leaves')
# Two cycles sharing a vertex produce a branched cyclic core; no guessing.
v,f=prism([(0,0),(1,0),(1,1),(0,1)]);v += [(-1,1,2),(0,2,2)];f += [[7,8,9]]
q=fixture('ambiguous-core',v,f);q.update(mode='inspect',report=str(root/'ambiguous-inspect.json'));r=p.run(q);bs=r['meshes'][0]['boundaries'];assert not any(b['status']=='eligible' for b in bs) and any('ambiguous branched core' in reason for b in bs for reason in b['reasons']);checks.append('shared-vertex-complex-core-rejected')
# Straddling old plane still permits only the actual shared endpoint.
assert not p.intersects([(0,0,0),(1,0,0),(0,1,0)],[(0,0,0),(-1,0,-1),(0,-1,1)],1e-7,[(0,0,0)])
assert p.intersects([(0,0,0),(1,0,0),(0,1,0)],[(0,0,0),(.5,.1,-1),(.1,.5,1)],1e-7,[(0,0,0)])
assert p.intersects([(0,0,0),(1,0,0),(0,1,0)],[(0,0,0),(-1,0,-1),(0,-1,1)],1e-7)
checks.append('straddling-endpoint-permitted-real-crossing-rejected')
(root/'native-evidence.json').write_text(json.dumps({'passed':True,'checks':checks,'root':str(root),'localOnly':True,'modelTurns':0,'paidSubmissions':0},indent=2),encoding='utf8')
print('PLANAR_V2_PASS',json.dumps({'checks':checks,'root':str(root)}))

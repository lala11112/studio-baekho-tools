"""Read-only Blender QA. -- manifest.json; no product modules or worker reports used."""
import bpy, json, pathlib, sys, hashlib, math
from mathutils import Vector
from mathutils.geometry import closest_point_on_tri

manifest=pathlib.Path(sys.argv[sys.argv.index('--')+1]).resolve()
q=json.loads(manifest.read_text(encoding='utf-8-sig'))
out=pathlib.Path(q['output']).resolve();out.mkdir(parents=True,exist_ok=True)
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
snapshots={}
for entry in q.get('protectedFiles',[]):assert sha(entry['path'])==entry['sha256'],entry['path']

def material(m):
    if m is None:return None
    nodes=[n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED'] if m.use_nodes else []
    return {'name':m.name,'diffuse':list(m.diffuse_color),'principled':[{
        k:list(n.inputs[k].default_value) if k in ('Base Color','Emission Color') else n.inputs[k].default_value
        for k in ('Base Color','Roughness','Metallic','Emission Strength','Emission Color','Alpha')} for n in nodes]}

def snapshot(entry):
    p=pathlib.Path(entry['path']);assert sha(p)==entry['sha256'],str(p)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if p.suffix.lower()=='.blend':bpy.ops.wm.open_mainfile(filepath=str(p),load_ui=False,use_scripts=False)
    elif p.suffix.lower()=='.fbx':bpy.ops.import_scene.fbx(filepath=str(p),use_image_search=False)
    elif p.suffix.lower()=='.glb':bpy.ops.import_scene.gltf(filepath=str(p))
    else:raise AssertionError('Unsupported snapshot format')
    bpy.context.view_layer.update();objects={};points=[]
    for o in bpy.context.scene.objects:
        assert not o.animation_data and not o.constraints and not o.modifiers,(o.name,'unexpected dynamic data')
        row={'type':o.type,'parent':o.parent.name if o.parent else None,'location':list(o.location),'rotationMode':o.rotation_mode,'rotation':list(o.rotation_euler),'scale':list(o.scale),'parentInverse':[list(r) for r in o.matrix_parent_inverse],'world':[list(r) for r in o.matrix_world]}
        if o.type=='MESH':
            m=o.data; m.calc_loop_triangles()
            world=[tuple(o.matrix_world@v.co) for v in m.vertices];points+=world
            row.update(vertices=[tuple(v.co) for v in m.vertices],polygons=[tuple(f.vertices) for f in m.polygons],materialIndices=[f.material_index for f in m.polygons],uv=[{'name':l.name,'render':l.active_render,'values':[tuple(v.uv) for v in l.data]} for l in m.uv_layers],materials=[material(x) for x in m.materials])
            uv=m.uv_layers.active
            assert uv is not None,(entry['label'],o.name,'missing UV')
            row['triangles']=[{'p':[world[i] for i in t.vertices],'uv':[tuple(uv.data[i].uv) for i in t.loops],'material':t.material_index} for t in m.loop_triangles]
            assert all(abs((Vector(t['uv'][1])-Vector(t['uv'][0])).cross(Vector(t['uv'][2])-Vector(t['uv'][0])))>1e-12 for t in row['triangles']),(entry['label'],o.name,'degenerate UV')
        objects[o.name]=row
    assert points
    return {'objects':objects,'bounds':{'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]}}

for entry in q['entries']:snapshots[entry['label']]=snapshot(entry)
(out/'raw-snapshots.json').write_text(json.dumps(snapshots,indent=2),encoding='utf8')
if q.get('snapshotOnly'):
    assert all(sha(entry['path'])==entry['sha256'] for entry in q['entries'])
    assert all(sha(entry['path'])==entry['sha256'] for entry in q.get('protectedFiles',[]))
    sys.exit(0)  # Double-precision offline analysis avoids mathutils FP32 cancellation.
checks=[]
def native_equal(a,b,materials=True):
    def selected(label):
        result={}
        for name,row in snapshots[label]['objects'].items():
            result[name]={k:v for k,v in row.items() if k!='triangles' and (materials or k not in ('materials',))}
        return result
    assert selected(a)==selected(b),(a,b,'native geometry/TRS/UV/material mismatch')
    checks.append(a+' -> '+b+' exact native '+('geometry/TRS/UV/material' if materials else 'geometry/TRS/UV'))

native_equal('candidate2','uv')
native_equal('uv','material',False)
native_equal('material','export')
for label in q.get('extraNativeExports', []):native_equal('material',label)
first=[m for o in snapshots['candidate1']['objects'].values() for m in o.get('materials',[]) if m]
second=[m for o in snapshots['candidate2']['objects'].values() for m in o.get('materials',[]) if m]
colors=lambda ms:sorted(set(tuple(n['Base Color']) for m in ms for n in m['principled']))
assert first and second and colors(first)!=colors(second),'candidate colors do not differ'
checks.append('two candidate material colors differ; geometry differences not required')
linear=lambda c:c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
expected=[1,linear(128/255),0,1]
for o in snapshots['material']['objects'].values():
    for m in o.get('materials',[]):
        assert m and len(m['principled'])==1
        shader=m['principled'][0]
        assert max(abs(a-b) for a,b in zip(shader['Base Color'],expected))<1e-6
        for name,value in [('Roughness',.2),('Metallic',0),('Emission Strength',0),('Alpha',1)]:assert abs(shader[name]-value)<1e-6,(name,shader[name])
checks.append('T05 exact requested linear orange/roughness.2/metallic0/emission0/opacity1')

def surface_match(source,target,tolerance):
    # Compare the world-space surface and UV interpolation in both directions.
    # Polygon triangulation and render vertex splits need not have identical indices.
    def triangles(s):return [t for o in snapshots[s]['objects'].values() for t in o.get('triangles',[])]
    aa,bb=triangles(source),triangles(target)
    assert len(aa)==len(bb),(source,target,'triangle count mismatch')
    def area(ts):return sum((Vector(t['p'][1])-Vector(t['p'][0])).cross(Vector(t['p'][2])-Vector(t['p'][0])).length*.5 for t in ts)
    assert abs(area(aa)-area(bb))<max(1,area(aa))*2e-6
    largest=0
    for t in aa:
        points=[(t['p'][i],t['uv'][i]) for i in range(3)]+[(tuple(sum(t['p'][i][k] for i in range(3))/3 for k in range(3)),tuple(sum(t['uv'][i][k] for i in range(3))/3 for k in range(2)))]
        for point,uv in points:
            found=False
            for other in bb:
                a,b,c=map(Vector,other['p']);v0=b-a;v1=c-a
                normal=(Vector(t['p'][1])-Vector(t['p'][0])).cross(Vector(t['p'][2])-Vector(t['p'][0]))
                if normal.normalized().dot(v0.cross(v1).normalized())<.99999:continue
                d00=v0.dot(v0);d01=v0.dot(v1);d11=v1.dot(v1);denom=d00*d11-d01*d01
                if abs(denom)<1e-20:continue
                # Use geometric distance at triangle edges. A fixed barycentric
                # cutoff is scale-dependent and rejects harmless thin-face FP noise.
                closest=closest_point_on_tri(Vector(point),a,b,c);v2=closest-a
                y=(d11*v2.dot(v0)-d01*v2.dot(v1))/denom;z=(d00*v2.dot(v1)-d01*v2.dot(v0))/denom;x=1-y-z
                error=(closest-Vector(point)).length
                error_uv=max(abs(other['uv'][0][k]*x+other['uv'][1][k]*y+other['uv'][2][k]*z-uv[k]) for k in range(2))
                if error<=tolerance and error_uv<=2e-6:largest=max(largest,error);found=True;break
            assert found,(source,target,'unmatched world/UV surface point',point,uv)
    return largest

extent=max(snapshots['export']['bounds']['max'][i]-snapshots['export']['bounds']['min'][i] for i in range(3))
tolerance=max(extent*2e-6,1e-7)
transport={}
for label in q.get('exportLabels', ['export_fbx','export_glb']):
    transport[label]={'forwardMaxError':surface_match('export',label,tolerance),'reverseMaxError':surface_match(label,'export',tolerance)}
    for obj in snapshots[label]['objects'].values():
        for m in obj.get('materials',[]):
            assert m and len(m['principled'])==1,(label,'missing Principled material')
            shader=m['principled'][0]
            assert max(abs(a-b) for a,b in zip(shader['Base Color'],expected))<2e-6,(label,'export color mismatch',shader)
            for name,value in [('Roughness',.2),('Metallic',0),('Alpha',1)]:assert abs(shader[name]-value)<2e-6,(label,name,shader[name])
            assert max(abs(c*shader['Emission Strength']) for c in shader['Emission Color'][:3])<2e-6,(label,'unexpected export emission')
    checks.append(label+' world surface/UV/triangle count and total area match both directions')
    checks.append(label+' orange/roughness/metallic/opacity/effective emission retained')
assert 'Lid' in snapshots['export']['objects'],'open lid object missing'
checks.append('static open lid preserved by native exact TRS and world-space export surface checks; no hinge animation claimed')
assert all(sha(entry['path'])==entry['sha256'] for entry in q['entries'])
assert all(sha(entry['path'])==entry['sha256'] for entry in q.get('protectedFiles',[]))
checks.append('all inspected source files SHA exact before/after')
result={'status':'PASS','checks':checks,'worldTolerance':tolerance,'transport':transport,'snapshots':snapshots,'entries':q['entries'],'limitations':['Static geometry/UV/material transport only; no rig, hinge animation, Unity playback or appearance acceptance.']}
(out/'independent-native.json').write_text(json.dumps(result,indent=2),encoding='utf8')

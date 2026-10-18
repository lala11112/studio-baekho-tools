import ast,copy,json,math,sys
from pathlib import Path
import bpy

worker=Path(sys.argv[sys.argv.index('--')+1]); output=Path(sys.argv[-1])
tree=ast.parse(worker.read_text(encoding='utf-8-sig'))
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='plan_repairs')
scope={'math':math};exec(compile(ast.Module(body=[node],type_ignores=[]),str(worker),'exec'),scope)
plan=scope['plan_repairs'];checks=[]
before={'body':[{'thumb':.8,'thigh':.2,'mask':.7},{'thumb':.6,'thigh':.4},{'thigh':1.0}], 'hair':[{'head':1.0}]}
selection={('body','a'):[0],('body','b'):[1],('body','overlap'):[0,1]}
repairs=[{'mesh':'body','islandId':i,'kind':'remove-influence','bones':['thumb']} for i in ['a','b']]
original=copy.deepcopy(before)
touched,planned=plan(before,selection,repairs,{'thumb','thigh','head'})
assert planned['body']=={0:{'mask':.7,'thigh':1.0},1:{'thigh':1.0}} and not planned['hair'] and before==original
checks.append('disjoint batch normalizes only residual deform weights and preserves auxiliary/source rows')
def reject(label,rows=before,items=repairs):
    saved=copy.deepcopy(rows)
    try:plan(rows,selection,items,{'thumb','thigh','head'})
    except (AssertionError,KeyError,TypeError):pass
    else:raise AssertionError(label)
    assert rows==saved;checks.append(label)
bad=copy.deepcopy(before);bad['body'][1]={'thumb':1.,'mask':.8}
reject('late auxiliary-only residual rejects entire batch without mutating first row',bad)
bad=copy.deepcopy(before);bad['body'][1]={'thumb':1.}
reject('late empty residual rejects entire batch',bad)
for bad_value in [float('nan'),float('inf'),-.2]:
    bad=copy.deepcopy(before);bad['body'][1]['thigh']=bad_value
    reject('nonfinite or negative residual rejected '+str(bad_value),bad)
reject('overlapping exact vertex sets rejected',items=[repairs[0],{**repairs[1],'islandId':'overlap'}])
reject('duplicate island rejected',items=[repairs[0],repairs[0]])
reject('unknown island rejected',items=[{**repairs[0],'islandId':'unknown'}])
reject('unknown removal bone rejected',items=[{**repairs[0],'bones':['mask']}])
reject('duplicate removal bone rejected',items=[{**repairs[0],'bones':['thumb','thumb']}])
# Tiny Blender data confirms the application writes only planned rows, with no addon/export/AI.
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
objects=[]
for name,positions in [('body',[(0,0,0),(1,0,0),(2,0,0)]),('hair',[(0,1,0)])]:
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(positions,[],[])
    obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);objects.append(obj)
    obj['partsmith_part_id']=name
    for i,row in enumerate(before[name]):
        for bone,w in row.items():
            group=obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone);group.add([i],w,'REPLACE')
def rows(obj):return [{obj.vertex_groups[g.group].name:g.weight for g in v.groups} for v in obj.data.vertices]
native={o.name:rows(o) for o in objects}
_,native_plan=plan(native,selection,repairs,{'thumb','thigh','head'})
for obj in objects:
    for i,row in native_plan[obj.name].items():
        for group in obj.vertex_groups:group.remove([i])
        for bone,w in row.items():
            group=obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone);group.add([i],w,'REPLACE')
assert rows(objects[0])[0]=={'mask':native['body'][0]['mask'],'thigh':1.0}
assert rows(objects[0])[2]==native['body'][2] and rows(objects[1])==native['hair']
assert objects[1]['partsmith_part_id']=='hair' and rows(objects[1])==[{'head':1.0}]
checks.append('Blender outside rows/auxiliary mask/head-bound hair/part IDs exact')
output.write_text(json.dumps({'status':'PASS','checks':checks,'aiExecutions':0,'licensedExports':0}),encoding='utf-8')

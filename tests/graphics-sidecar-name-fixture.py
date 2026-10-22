import bpy, pathlib, tempfile, hashlib, json, shutil, sys, runpy, copy

root=pathlib.Path(sys.argv[sys.argv.index('--')+1]).resolve()
repo=pathlib.Path(__file__).resolve().parents[1]
original=root/'original';original.mkdir();stage=root/'stage';stage.mkdir()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.mesh.primitive_cube_add();obj=bpy.context.object
image=bpy.data.images.new('Pattern',width=2,height=2);image.pixels=[1,0,0,1]*4
image.filepath_raw=str(original/'pattern.png');image.file_format='PNG';image.save()
mat=bpy.data.materials.new('Material');mat.use_nodes=True;node=mat.node_tree.nodes.new('ShaderNodeTexImage');node.image=image
mat.node_tree.links.new(node.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);obj.data.materials.append(mat)
source=original/'source.fbx';bpy.ops.export_scene.fbx(filepath=str(source),use_selection=True,path_mode='RELATIVE',embed_textures=False,bake_anim=False,add_leaf_bones=False)
(original/'pattern.png').rename(original/'PATTERN.PNG')
before={p.name:sha(p) for p in original.iterdir()};files=[]
for i,p in enumerate(original.iterdir()):
    target=stage/(str(i)+'-'+p.name);shutil.copyfile(p,target)
    files.append({'path':p.name,'original':str(p),'local':str(target),'sha256':sha(p),'bytes':p.stat().st_size,'kind':'model' if p.suffix=='.fbx' else 'image'})
src=next(f for f in files if f['kind']=='model');texture=next(f for f in files if f['kind']=='image')
results=[]
def execute(operation,scenario,items):
    output=root/(operation+'-'+scenario)
    if operation=='N01':output.mkdir()
    q={'identity':operation+'-'+scenario,'source':src['local'],'sourceSha256':src['sha256'],'inputRoot':str(stage),'output':str(output),'files':items,'axis':'X','taskId':operation,'settings':{'roughness':.5,'uvMode':'keep'}}
    request=root/(operation+'-'+scenario+'.json');request.write_text(json.dumps(q));sys.argv=['fixture','--',str(request)]
    script='graphics_motion_source.py' if operation=='N01' else 'graphics_procedural.py'
    runpy.run_path(str(repo/'integrations/blender'/script),run_name='__main__')
    return output
for operation in ['T02','T05','N01']:
    output=execute(operation,'case-match',files)
    if operation=='N01':
        report=json.loads((output/'render.json').read_text());assert report['fullBodyInFrame'] and not report['missingImages']
    else:
        report=json.loads((output/'inspection.json').read_text());assert report['originalTexturesPreserved']
        assert texture['sha256'] in [sha(p) for p in (output/'Textures').iterdir()]
    results.append(operation+'-case-match')
    duplicate=copy.deepcopy(texture);duplicate['original']=str(original/'other'/'pattern.png')
    for scenario,items in [('missing',[src]),('duplicate',[*files,duplicate])]:
        try:execute(operation,scenario,items);raise AssertionError('unexpected success '+operation+' '+scenario)
        except RuntimeError as error:
            assert ('Ambiguous registered' if scenario=='duplicate' else 'packed or') in str(error),str(error)
        results.append(operation+'-'+scenario+'-blocked')
# Execute each real worker prefix to check its own local normalization utility,
# without adding another expensive render or changing either production loader.
for script in ['graphics_procedural.py','graphics_motion_source.py']:
    text=(repo/'integrations/blender'/script).read_text();start=text.index('def image_name(');end=text.index('\n\n',start)
    namespace={'unicodedata':__import__('unicodedata')};exec(text[start:end],namespace)
    assert namespace['image_name']('Folder/É.PNG')==namespace['image_name']('folder/e\u0301.png')
    assert namespace['image_name']('Straße.png')==namespace['image_name']('STRASSE.PNG')
    results.append(script+'-unicode-normalized')
assert before=={p.name:sha(p) for p in original.iterdir()}
assert all(sha(pathlib.Path(f['local']))==f['sha256'] for f in files)
(root/'result.json').write_text(json.dumps({'passed':True,'checks':results,'originalsExact':True,'stagedInputsExact':True,'paid':0,'modelTurns':0},indent=2))

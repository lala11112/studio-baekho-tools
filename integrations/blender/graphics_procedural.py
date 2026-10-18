"""Finite offline presets and explicit UV/material edits. Never writes a source file."""
import bpy, json, pathlib, sys, math, hashlib, re, unicodedata
from mathutils import Vector
from mathutils.kdtree import KDTree
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from graphics_glb import export_packed_glb, active_uv_first_export
from contextlib import nullcontext

def image_name(value):
    return unicodedata.normalize('NFC', str(value).replace('\\','/').rsplit('/',1)[-1]).casefold()

q = json.loads(pathlib.Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
s = q['settings']; operation = q['taskId']; out = pathlib.Path(q['output']).resolve()
out.mkdir(parents=True, exist_ok=False)
warnings = []; changes = []; preserved_images = []
attr = lambda key, fallback: s.get('attr.' + key, fallback)
digest = lambda data: hashlib.sha256(data).hexdigest()
input_root = pathlib.Path(q['inputRoot']).resolve()
for item in q['files']:
    file = pathlib.Path(item['local']).resolve()
    if not file.is_relative_to(input_root) or digest(file.read_bytes()) != item['sha256']:
        raise RuntimeError('Immutable input hash or path changed')

def principled(name, color, roughness=.65, metallic=0):
    material = bpy.data.materials.new(name); material.use_nodes = True
    node = material.node_tree.nodes.get('Principled BSDF')
    node.inputs['Base Color'].default_value = (*color, 1)
    node.inputs['Roughness'].default_value = roughness
    node.inputs['Metallic'].default_value = metallic
    material.diffuse_color = (*color, 1)
    return material

def cube(name, location, dimensions, material, cuts=0, rounding=0):
    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object; obj.name = name
    if cuts:
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.subdivide(number_cuts=cuts); bpy.ops.object.mode_set(mode='OBJECT')
    for vertex in obj.data.vertices:
        original = vertex.co.copy()
        vertex.co = (original * (1-rounding) + original.normalized() * rounding) * Vector(dimensions) / 2
    obj.data.materials.append(material)
    return obj

if operation == 'M04':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    subject = s['subject']; style = attr('style', 'stylized'); shape = attr('shape', 'rounded')
    seed = int(s.get('variationSeed', 1)); phase = seed * 1.917
    width, depth, height = [float(attr(key, 1)) for key in ['width', 'depth', 'height']]
    if shape == 'flat': height *= .35
    if shape == 'long': width *= 1.9
    dimensions = (width, depth, height)
    cuts = {'lowpoly': 2, 'stylized': 6, 'anime': 6, 'realistic': 18}[style]
    if subject == 'rock':
        colors = {'lowpoly': (.27,.3,.35), 'stylized': (.32,.37,.45), 'anime': (.38,.41,.54), 'realistic': (.25,.23,.21)}
        surface = attr('surface','rough'); cracks = attr('cracks','none'); moss = attr('moss','none')
        stone = principled('Stone', colors[style], {'smooth':.35,'rough':.7,'rugged':.92}[surface])
        moss_material = principled('Moss surface patches', (.065,.16,.025), .95)
        obj = cube('Rock', (0,0,height/2), dimensions, stone, cuts)
        obj.data.materials.append(moss_material)
        for vertex in obj.data.vertices:
            p = Vector((vertex.co.x/width, vertex.co.y/depth, vertex.co.z/height))*2
            direction = p.normalized()
            rounding = .92 if shape == 'rounded' else .28 if shape == 'angular' else .65
            base = p*(1-rounding)+direction*rounding
            sample_x = abs(direction.x) if s.get('symmetry',True) else direction.x
            wave = math.sin(sample_x*3.7+phase)*math.sin(direction.y*4.3-phase)*math.cos(direction.z*5.1+phase)
            amplitude = {'smooth':.025,'rough':.11,'rugged':.24}[surface]
            # Continuous localized grooves, not a fractured/destructible interior.
            groove = 0
            if cracks != 'none':
                frequency = 3 if cracks == 'few' else 8
                line = abs(math.sin(sample_x*frequency+direction.z*2+phase))
                groove = max(0,1-line/.18) * (.055 if cracks == 'few' else .095)
            vertex.co = base*(1+wave*amplitude-groove)*Vector(dimensions)/2
        obj.data.update()
        for polygon in obj.data.polygons:
            polygon.use_smooth = style != 'lowpoly' and shape != 'angular'
            if moss != 'none':
                center = polygon.center; threshold = .65 if moss == 'some' else -.1
                patch_x = abs(center.x) if s.get('symmetry',True) else center.x
                if polygon.normal.z > .15 and math.sin(patch_x*8+phase)*math.cos(center.y*7-phase) > threshold:
                    polygon.material_index = 1
        if cracks != 'none': warnings.append('균열은 표면 메시 홈입니다. 내부 파단·물리 파괴 구조는 생성하지 않습니다.')
        if moss != 'none': warnings.append('이끼는 윗면의 재질 패치입니다. 이끼 털·개별 잎·베이크 텍스처는 생성하지 않습니다.')
    elif subject == 'box':
        container = attr('container','crate'); interior = attr('interior','solid'); lid = attr('lid','none')
        metal = container == 'metal'; color = (.22 + .025*math.sin(phase),.29,.34) if metal else (.28 + .025*math.sin(phase),.13,.048)
        if style == 'anime': color=tuple(min(1,c*1.35) for c in color)
        if style == 'realistic': color=tuple(c*.85 for c in color)
        material = principled('Metal' if metal else 'Wood', color, .45 if style=='anime' else .3 if metal else .72, .8 if metal else 0)
        rounding = .25 if shape == 'rounded' else 0
        box_cuts = (1 if shape=='rounded' else 0) if style == 'lowpoly' else 2 if style in {'stylized','anime'} else 5
        thickness = min(dimensions)*.09
        if interior == 'solid': cube('Box body',(0,0,height/2),dimensions,material,box_cuts,rounding)
        else:
            cube('Box bottom',(0,0,thickness/2),(width,depth,thickness),material,box_cuts)
            for name, location, size in [
                ('Left',(-width/2+thickness/2,0,height/2),(thickness,depth,height)),
                ('Right',(width/2-thickness/2,0,height/2),(thickness,depth,height)),
                ('Front',(0,-depth/2+thickness/2,height/2),(width-2*thickness,thickness,height)),
                ('Back',(0,depth/2-thickness/2,height/2),(width-2*thickness,thickness,height))]:
                cube('Box '+name,location,size,material,box_cuts,rounding)
        if lid != 'none':
            top = cube('Lid',(0,0,height+thickness/2),(width,depth,thickness*(2 if container=='chest' else 1)),material,box_cuts,rounding)
            if lid == 'open':
                # Rear edge pivot, actual open lid geometry without a promised rigged hinge.
                for vertex in top.data.vertices: vertex.co.y -= depth/2
                top.location.y = depth/2; top.rotation_euler.x = math.radians(-105)
        if container == 'chest':
            bands = principled('Chest metal bands',(.12,.12,.1),.45,.7)
            for x in [-width*.32,width*.32]: cube('Chest band',(x,-depth/2-thickness*.08,height/2),(width*.07,thickness*.16,height),bands)
        if container == 'crate':
            for z in [height*.17,height*.83]: cube('Crate rail',(0,-depth/2-thickness*.08,z),(width,thickness*.16,height*.08),material)
        warnings.append('상자는 독립 메시 벽·뚜껑의 정적 형상입니다. 경첩 리그·개폐 애니메이션·목재 이미지 텍스처는 생성하지 않습니다.')
    else: raise RuntimeError('Unsupported local subject')
    warnings.append('선택 이미지의 외형 재현 결과가 아닌 수치 기반 로컬 프리셋입니다. AI 재구성·유사도 검증은 수행하지 않았습니다.')
    if style == 'realistic': warnings.append('사실적 옵션은 더 조밀한 메시와 어두운 기본 팔레트를 만듭니다. 사진급 표면 텍스처는 생성하지 않습니다.')
    if style == 'anime': warnings.append('애니풍 옵션은 프리셋 색·음영용 기본 재질을 조정합니다. 윤곽선·셀 셰이딩 셰이더는 생성하지 않습니다.')
else:
    source = pathlib.Path(q['source']).resolve()
    if not source.is_relative_to(input_root): raise RuntimeError('Source escaped staged input')
    if source.suffix.lower() == '.blend': bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if source.suffix.lower() == '.fbx': bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
        elif source.suffix.lower() == '.glb':
            from graphics_glb import inspect_glb
            inspect_glb(source.read_bytes()); bpy.ops.import_scene.gltf(filepath=str(source))
        else: raise RuntimeError('Unsupported immutable model format')
    if bpy.data.libraries: raise RuntimeError('Linked libraries must be made local before UV/material editing')

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes or any(not o.data.polygons for o in meshes): raise RuntimeError('No usable mesh')
def geometry_state():
    return {o.name: {'vertices': [list(v.co) for v in o.data.vertices], 'polygons': [list(p.vertices) for p in o.data.polygons]} for o in meshes}
def uv_state():
    return {o.name: {layer.name: [list(p.uv) for p in layer.data] for layer in o.data.uv_layers} for o in meshes}
before_geometry = geometry_state(); before_uv = uv_state()

# Keep exact encoded sources, including disconnected image nodes after explicit material overrides.
texture_dir = out/'Textures'
for index, image in enumerate(bpy.data.images):
    if image.type == 'RENDER_RESULT': continue
    if image.source not in {'FILE','GENERATED'}: raise RuntimeError('Image sequence/movie textures are not supported')
    if image.packed_file: raw = bytes(image.packed_file.data)
    else:
        basename = image_name(image.filepath)
        matches = [item for item in q['files'] if image_name(item['original']) == basename]
        if len(matches) > 1: raise RuntimeError('Ambiguous registered texture filename: '+image.name)
        local = pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
        if len(matches) == 1: raw = pathlib.Path(matches[0]['local']).read_bytes()
        elif local.is_file() and local.is_relative_to(input_root): raw = local.read_bytes()
        else: raise RuntimeError('Texture must be packed or uniquely declared: '+image.name)
    ext = '.png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else '.jpg' if raw.startswith(b'\xff\xd8\xff') else None
    if not ext: raise RuntimeError('Preserved texture must be encoded PNG/JPEG: '+image.name)
    texture_dir.mkdir(exist_ok=True)
    name = str(index)+'_'+(re.sub(r'[^a-zA-Z0-9_-]','_',pathlib.Path(image.name).stem) or 'image')+ext
    target = texture_dir/name; target.write_bytes(raw)
    image.pack(data=raw, data_len=len(raw)); image.filepath = '//Textures/'+name
    preserved_images.append({'name': image.name, 'path': 'Textures/'+name, 'sha256':digest(raw), 'width':image.size[0], 'height':image.size[1]})

def make_uv(obj):
    bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active=obj
    layer = obj.data.uv_layers.new(name='Partsmith UV')
    obj.data.uv_layers.active = layer; layer.active_render = True
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.03)
    bpy.ops.object.mode_set(mode='OBJECT')
def valid_uv(obj):
    uv = obj.data.uv_layers.active
    if uv is None or len(uv.data) != len(obj.data.loops): return False
    if any(not math.isfinite(c) for item in uv.data for c in item.uv): return False
    return all(abs(sum(uv.data[p.loop_indices[i]].uv.x*uv.data[p.loop_indices[(i+1)%len(p.loop_indices)]].uv.y-uv.data[p.loop_indices[(i+1)%len(p.loop_indices)]].uv.x*uv.data[p.loop_indices[i]].uv.y for i in range(len(p.loop_indices))))>1e-12 for p in obj.data.polygons)

if operation == 'T02':
    if s.get('uvMode','local') == 'keep':
        if not all(valid_uv(o) for o in meshes): raise RuntimeError('Keep UV requires valid nondegenerate UV on every mesh face')
    else:
        for obj in meshes: make_uv(obj)
        warnings.append('기존 UV 층과 원본 텍스처를 보관하고 새 UV를 활성화했습니다. 새 배치에서 기존 텍스처 위치는 달라질 수 있으며 베이크는 수행하지 않았습니다.')
elif operation == 'M04':
    for obj in meshes: make_uv(obj)
elif operation == 'T05':
    material_set = set()
    for obj in meshes:
        if not obj.data.materials: obj.data.materials.append(principled('Local material',(.5,.5,.5)))
        for i, material in enumerate(obj.data.materials):
            if material is None: obj.data.materials[i] = principled('Local material',(.5,.5,.5))
            material_set.add(obj.data.materials[i])
    linear = lambda c: c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
    for material in material_set:
        if not material.use_nodes: raise RuntimeError('Only explicit Principled node materials are supported: '+material.name)
        nodes = material.node_tree.nodes; outputs = [n for n in nodes if n.type=='OUTPUT_MATERIAL' and n.is_active_output]
        if len(outputs)!=1 or not outputs[0].inputs['Surface'].is_linked: raise RuntimeError('Material has no single active surface: '+material.name)
        shader = outputs[0].inputs['Surface'].links[0].from_node
        if shader.type!='BSDF_PRINCIPLED' or len(outputs[0].inputs['Surface'].links)!=1: raise RuntimeError('Complex surface shader is not supported: '+material.name)
        requested = {k:s[k] for k in ['color','roughness','metallic','emission','opacity'] if k in s}
        for key, value in requested.items():
            socket_name = {'color':'Base Color','roughness':'Roughness','metallic':'Metallic','emission':'Emission Strength','opacity':'Alpha'}[key]
            socket = shader.inputs[socket_name]
            if socket.is_linked:
                changes.append({'material':material.name,'channel':key,'disconnected':[link.from_node.name for link in socket.links]})
                for link in list(socket.links): material.node_tree.links.remove(link)
            if key=='color':
                color = tuple(linear(int(str(value)[i:i+2],16)/255) for i in [1,3,5]); socket.default_value=(*color,1); material.diffuse_color=(*color,1)
            else: socket.default_value=float(value)
            if key=='emission' and value>0:
                emission_color=shader.inputs['Emission Color']
                if not emission_color.is_linked and max(emission_color.default_value[:3])==0:
                    emission_color.default_value=shader.inputs['Base Color'].default_value; changes.append({'material':material.name,'channel':'emissionColor','reason':'Use base color for explicitly enabled emission'})
            if key=='opacity' and value<1:
                if hasattr(material,'surface_render_method'): material.surface_render_method='DITHERED'
        changes.append({'material':material.name,'values':requested})
    warnings.append('선택한 재질 채널은 명시 수치로 대체했습니다. 해당 채널의 기존 텍스처 연결은 해제될 수 있으며 원본 이미지 노드·바이트·UV는 보관합니다.')
else: raise RuntimeError('Unsupported local operation')

if not all(valid_uv(o) for o in meshes) and operation in {'M04','T02'}: raise RuntimeError('Result UV contains missing or degenerate faces')
faces = sum(len(o.data.polygons) for o in meshes); quads = sum(len(p.vertices)==4 for o in meshes for p in o.data.polygons)
if operation=='M04':
    if faces>int(s.get('faceLimit',10000)): raise RuntimeError('Preset exceeds requested face limit; choose lowpoly or a larger limit')
    if s.get('quad',True) and quads!=faces: raise RuntimeError('Preset failed all-quad native mesh contract')
    if s.get('quad') is False:
        for obj in meshes:
            bpy.context.view_layer.objects.active=obj; triangulate=obj.modifiers.new('Explicit triangle topology','TRIANGULATE'); bpy.ops.object.modifier_apply(modifier=triangulate.name)
        faces=sum(len(o.data.polygons) for o in meshes); quads=0
        if faces>int(s.get('faceLimit',10000)): raise RuntimeError('Triangle preset exceeds requested face limit')
mesh_geometry=[]
for obj in meshes:
    obj.data.calc_loop_triangles()
    mesh_geometry.append({'name':obj.name,'vertices':len(obj.data.vertices),'faces':len(obj.data.polygons),
        'triangles':len(obj.data.loop_triangles),'quads':sum(len(p.vertices)==4 for p in obj.data.polygons)})
triangles=sum(item['triangles'] for item in mesh_geometry)
symmetry_evidence=None
if operation=='M04':
    bpy.context.view_layer.update()
    points=[obj.matrix_world@vertex.co for obj in meshes for vertex in obj.data.vertices]
    tree=KDTree(len(points))
    for index, point in enumerate(points): tree.insert(point,index)
    tree.balance()
    max_error=max(tree.find(Vector((-point.x,point.y,point.z)))[2] for point in points)
    tolerance=max(1.0,max(point.length for point in points))*1e-5
    symmetry_evidence={'requested':s.get('symmetry',True),'axis':'X','space':'scene','maxMirrorError':max_error,'tolerance':tolerance,'verified':max_error<=tolerance}
    if s.get('symmetry',True) and not symmetry_evidence['verified']: raise RuntimeError('Requested X symmetry failed the actual mirrored-vertex check')
    warnings.append('면 수 설정은 편집 메시의 최대 폴리곤 수입니다. 실제 폴리곤·삼각형 수는 검사 보고서에 별도로 기록했습니다.')
geometry_preserved = before_geometry==geometry_state(); uv_preserved=before_uv==uv_state()
if operation=='T05' and (not geometry_preserved or not uv_preserved): raise RuntimeError('Material edit changed geometry or UV')
if operation=='T02' and not geometry_preserved: raise RuntimeError('UV edit changed geometry')
for item in preserved_images:
    image=bpy.data.images[item['name']]
    if digest(bytes(image.packed_file.data))!=item['sha256'] or digest((out/item['path']).read_bytes())!=item['sha256']: raise RuntimeError('Original texture bytes changed')

bpy.ops.object.select_all(action='DESELECT')
for obj in bpy.context.scene.objects:
    if obj.type in {'MESH','ARMATURE','EMPTY'}: obj.select_set(True)
bpy.context.view_layer.objects.active=meshes[0]
bpy.ops.wm.save_as_mainfile(filepath=str(out/'Asset.blend'), compress=False)
export_uv = []
export_copies, export_materials = [], {}
try:
    if operation == 'T02' and s.get('uvMode', 'local') != 'keep':
        # Upload consumers commonly use UV set 0, ignoring active_render.
        # Every layer remains in the saved editable BLEND. Only these temporary
        # FBX/GLB copies contain a single explicitly selected new UV set.
        for obj in meshes:
            original = obj.data
            selected = original.uv_layers.active
            if selected is None or not selected.active_render:
                raise RuntimeError('UV export requires the explicitly active new UV layer')
            copy = original.copy(); obj.data = copy; export_copies.append((obj, original, copy))
            chosen = copy.uv_layers.get(selected.name)
            for layer in list(copy.uv_layers):
                if layer != chosen: copy.uv_layers.remove(layer)
            chosen = copy.uv_layers[0]; chosen.name = 'Partsmith UV'; copy.uv_layers.active = chosen; chosen.active_render = True
            for index, material in enumerate(copy.materials):
                if not material: continue
                if not material.use_nodes or not any(node.type == 'UVMAP' for node in material.node_tree.nodes): continue
                key = material.as_pointer()
                if key not in export_materials:
                    derivative = material.copy()
                    if derivative.use_nodes:
                        for node in derivative.node_tree.nodes:
                            if node.type == 'UVMAP': node.uv_map = chosen.name
                    export_materials[key] = derivative
                copy.materials[index] = export_materials[key]
            export_uv.append({'mesh': obj.name, 'sourceLayer': selected.name, 'exportLayer': chosen.name, 'layerCount': 1})
            if not valid_uv(obj): raise RuntimeError('Selected export UV contains a degenerate face')
    with (nullcontext([]) if operation=='T02' and s.get('uvMode','local')!='keep' else active_uv_first_export(meshes,fbx=True)) as ordered_uv:
        if ordered_uv: export_uv.extend(ordered_uv)
        bpy.ops.export_scene.fbx(filepath=str(out/'Asset.fbx'), use_selection=True, object_types={'MESH','ARMATURE','EMPTY'}, add_leaf_bones=False,
            bake_anim=bool(bpy.data.actions), bake_anim_use_all_actions=True, bake_anim_use_nla_strips=False, bake_anim_simplify_factor=0.0, path_mode='COPY', embed_textures=True)
        glb_images=export_packed_glb(out/'Asset.glb', use_selection=True, export_animations=True)
finally:
    for obj, original, copy in export_copies:
        obj.data = original; bpy.data.meshes.remove(copy)
    for material in export_materials.values(): bpy.data.materials.remove(material)
material_parameters=[]
if operation=='M04':
    for material in sorted({material for obj in meshes for material in obj.data.materials if material},key=lambda item:item.name):
        node=material.node_tree.nodes.get('Principled BSDF')
        material_parameters.append({'name':material.name,'baseColor':list(node.inputs['Base Color'].default_value),'roughness':node.inputs['Roughness'].default_value,'metallic':node.inputs['Metallic'].default_value})
report = {'schemaVersion':1,'identity':q['identity'],'operation':operation,'originalPreserved':True,'vertices':sum(len(o.data.vertices) for o in meshes),
    'faces':faces,'triangles':triangles,'quads':quads,'geometryBasis':'editable-mesh-data','meshGeometry':mesh_geometry,
    'faceLimit':int(s.get('faceLimit',10000)) if operation=='M04' else None,'faceLimitSatisfied':faces<=int(s.get('faceLimit',10000)) if operation=='M04' else None,
    'symmetry':symmetry_evidence,'materialParameters':material_parameters,'geometryPreserved':geometry_preserved,'uvPreserved':uv_preserved,'originalTexturesPreserved':True,
    'originalImages':preserved_images,'selfContainedGlb':True,'glbImages':glb_images,'changes':changes,'warnings':warnings,
    'meshNames':[o.name for o in meshes], 'uvLayers':{o.name:[layer.name for layer in o.data.uv_layers] for o in meshes}, 'exportUV':export_uv, 'settings':s,
    'localOnly':True,'modelTurns':0,'paidSubmissions':0}
if q.get('sourceSha256'): report['sourceSha256']=q['sourceSha256']
(out/'inspection.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf8')

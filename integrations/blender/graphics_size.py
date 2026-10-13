"""Offline absolute size fitting shared by preview work copies and Unity delivery.
Source vertices, weights, bind matrices and Action curves are not rewritten.
"""
import bpy, math, hashlib, json
from mathutils import Matrix, Vector

MARKER = 'partsmith_physical_size_root'

def settings(value=None):
    if isinstance(value, str):
        value = json.loads(value)
    value = value or {}
    s = {'mode':value.get('mode','keep'),'axis':value.get('axis','y'),
         'lengthMeters':value.get('lengthMeters',1),
         'dimensionsMeters':dict({'x':1,'y':1,'z':1}, **value.get('dimensionsMeters',{})),
         'pivot':value.get('pivot','keep')}
    if s['mode'] not in {'keep','uniform','axes'} or s['axis'] not in {'x','y','z'} or s['pivot'] not in {'keep','bottom-center','center'}:
        raise RuntimeError('Invalid physical size mode/axis/pivot')
    if any(not isinstance(n,(int,float)) or not math.isfinite(n) or not .000001<=n<=1000000 for n in [s['lengthMeters'],*s['dimensionsMeters'].values()]):
        raise RuntimeError('Physical dimensions must be positive finite meter lengths')
    return s

def baseline_bounds(meshes):
    """Stable rest pose with shape keys zero; measured native mesh vertices, not animated AABBs."""
    scene=bpy.context.scene
    frame=scene.frame_current
    poses=[(o,o.data.pose_position) for o in scene.objects if o.type=='ARMATURE']
    keys=[(k,k.value) for o in meshes if o.data.shape_keys for k in o.data.shape_keys.key_blocks]
    try:
        scene.frame_set(scene.frame_start)
        for o,_ in poses:o.data.pose_position='REST'
        for k,_ in keys:k.value=0
        bpy.context.view_layer.update()
        units=scene.unit_settings.scale_length
        points=[]
        graph=bpy.context.evaluated_depsgraph_get()
        for obj in meshes:
            evaluated=obj.evaluated_get(graph)
            mesh=evaluated.to_mesh()
            try:
                for vertex in mesh.vertices:
                    p=evaluated.matrix_world@vertex.co
                    points.append((p.x*units,p.z*units,-p.y*units))
            finally:evaluated.to_mesh_clear()
        if not points or any(not math.isfinite(c) for p in points for c in p):
            raise RuntimeError('Cannot measure finite rest-pose mesh vertices')
        return {'min':dict(zip('xyz',(min(p[i] for p in points) for i in range(3)))),
                'max':dict(zip('xyz',(max(p[i] for p in points) for i in range(3))))}
    finally:
        for o,p in poses:o.data.pose_position=p
        for k,v in keys:k.value=v
        scene.frame_set(frame)
        bpy.context.view_layer.update()

def apply_physical_size(value, source_sha256):
    s=settings(value)
    scene=bpy.context.scene
    meshes=[o for o in scene.objects if o.type=='MESH']
    restricted=any(o.type=='ARMATURE' or o.animation_data or o.constraints for o in scene.objects) or any(o.data.shape_keys or any(m.type=='ARMATURE' for m in o.modifiers) for o in meshes) or bool(bpy.data.actions)
    if s['mode']=='axes' and restricted:
        raise RuntimeError('Rig/skin/animation/shape keys support proportional size only')
    changed=s['mode']!='keep' or s['pivot']!='keep'
    if changed and any(o.constraints or (o.animation_data and o.animation_data.drivers) or (o.type=='ARMATURE' and any(b.constraints for b in o.pose.bones)) for o in scene.objects):
        raise RuntimeError('Constrained/driven object transforms need an explicit authoring review before physical sizing')
    before=baseline_bounds(meshes)
    dimensions={a:before['max'][a]-before['min'][a] for a in 'xyz'}
    factors=dict.fromkeys('xyz',1.)
    if s['mode']=='uniform':
        length=dimensions[s['axis']]
        if length<1e-9:raise RuntimeError('Selected baseline axis has zero length')
        factors=dict.fromkeys('xyz',s['lengthMeters']/length)
    elif s['mode']=='axes':
        if min(dimensions.values())<1e-9:raise RuntimeError('Axis sizing requires nonzero dimensions')
        factors={a:s['dimensionsMeters'][a]/dimensions[a] for a in 'xyz'}
    anchor=dict.fromkeys('xyz',0.)
    if s['pivot']!='keep':
        anchor={a:(before['min'][a]+before['max'][a])/2 for a in 'xyz'}
        if s['pivot']=='bottom-center':anchor['y']=before['min']['y']
    if changed:
        units=scene.unit_settings.scale_length
        delta=Matrix.Diagonal((factors['x'],factors['z'],factors['y'],1))@Matrix.Translation(Vector((-anchor['x']/units,anchor['z']/units,-anchor['y']/units)))
        wrappers=[o for o in scene.objects if o.get(MARKER) and o.parent is None]
        if len(wrappers)>1:raise RuntimeError('Multiple physical-size roots are ambiguous')
        if wrappers:
            wrapper=wrappers[0]
            wrapper.matrix_world=delta@wrapper.matrix_world
        else:
            roots=[o for o in scene.objects if o.parent is None and o.type not in {'CAMERA','LIGHT'}]
            wrapper=bpy.data.objects.new('Partsmith_SizeRoot',None)
            wrapper[MARKER]=True
            scene.collection.objects.link(wrapper)
            for obj in roots:
                # The new parent is identity. Retain the original TRS channels
                # exactly instead of decomposing matrix_world into new channels.
                obj.parent=wrapper;obj.matrix_parent_inverse=Matrix.Identity(4)
            wrapper.matrix_world=delta
        bpy.context.view_layer.update()
    after=baseline_bounds(meshes)
    actual={a:after['max'][a]-after['min'][a] for a in 'xyz'}
    expected={a:dimensions[a]*factors[a] for a in 'xyz'}
    for a in 'xyz':
        if abs(actual[a]-expected[a])>max(.001,expected[a]*.001):
            raise RuntimeError('Physical size fitting did not reach the target: '+a)
    return {'schemaVersion':1,'sourceSha256':source_sha256,'settings':s,
            'basis':'rest-pose, shape keys zero, scene start frame; Unity X/Y/Z meters',
            'unitStatus':'calibrated' if s['mode']!='keep' else 'source-units-unconfirmed',
            'restricted':restricted,'before':before,'after':after,'dimensionsMeters':actual,
            'factors':factors,'transformed':changed,'originalPreserved':True}

def logical_parent(obj):
    parent=obj.parent
    while parent and parent.get(MARKER):parent=parent.parent
    return parent.name if parent else None

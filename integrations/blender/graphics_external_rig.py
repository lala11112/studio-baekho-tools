"""Offline, fail-closed external autorig handoff. Never modifies an input file."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def checked(path, digest):
    path = Path(path).resolve()
    if not digest or sha(path) != digest:
        raise ValueError('Input SHA256 mismatch: ' + str(path))
    return path


def load_scene(path):
    import bpy
    suffix = path.suffix.lower()
    if suffix == '.blend':
        bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if suffix == '.fbx':
            bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True)
        elif suffix in ('.glb', '.gltf'):
            bpy.ops.import_scene.gltf(filepath=str(path))
        else:
            raise ValueError('Unsupported source format')


def snapshot(static=False):
    import bpy
    meshes = []
    # Animation may belong to mesh/material/node-tree datablocks rather than objects.
    # Import actions intact and reject all animation before examining geometry.
    if len(bpy.data.actions):
        raise ValueError('Animation actions are unsupported')
    for collection in ('objects', 'meshes', 'armatures', 'materials', 'node_groups', 'shape_keys', 'scenes', 'worlds', 'textures', 'cameras', 'lights'):
        for block in getattr(bpy.data, collection, []):
            for owner in (block, getattr(block, 'node_tree', None)):
                animation = getattr(owner, 'animation_data', None)
                if animation and (animation.action or len(animation.drivers) or len(animation.nla_tracks)):
                    raise ValueError('Animated datablocks are unsupported')
    if static and (any(o.type == 'ARMATURE' for o in bpy.data.objects) or len(bpy.data.actions)):
        raise ValueError('Static handoff rejects armatures and actions')
    for obj in bpy.context.scene.objects:
        if obj.animation_data and (obj.animation_data.action or len(obj.animation_data.drivers) or len(obj.animation_data.nla_tracks)):
            raise ValueError('Animated objects are unsupported')
        if obj.constraints: raise ValueError('Object constraints unsupported')
        if obj.type != 'MESH':
            continue
        if obj.data.shape_keys or any(m.type != 'ARMATURE' or static for m in obj.modifiers):
            raise ValueError('Shape keys and unapplied modifiers are unsupported')
        if static and (obj.vertex_groups or obj.parent and obj.parent.type == 'ARMATURE'):
            raise ValueError('Static handoff rejects skin groups')
        obj.data.calc_loop_triangles()
        meshes.append({'name': obj.name, 'id': str(obj.get('partsmith_id', '')), 'partId': str(obj.get('partsmith_part_id', '')),
            'matrixWorld': [list(row) for row in obj.matrix_world],
            'positions': [list(obj.matrix_world @ v.co) for v in obj.data.vertices],
            'polygons': [list(p.vertices) for p in obj.data.polygons],
            'triangles': [list(t.vertices) for t in obj.data.loop_triangles],
            'uv': {layer.name: [list(x.uv) for x in layer.data] for layer in obj.data.uv_layers},
            'materialIndices': [p.material_index for p in obj.data.polygons],
            'materials': [m.name if m else None for m in obj.data.materials]})
    if not meshes:
        raise ValueError('No mesh geometry')
    return meshes


def validate_images():
    """Resolve actual source dependencies before packing; never accept a gray fallback."""
    import bpy
    for image in bpy.data.images:
        if image.type in {'RENDER_RESULT', 'COMPOSITING'}:
            continue
        if image.source not in {'FILE', 'GENERATED'}:
            raise ValueError('Unsupported image source: ' + image.name)
        if image.source == 'FILE' and not image.packed_file:
            resolved = Path(bpy.path.abspath(image.filepath, library=image.library)).resolve()
            if not resolved.is_file():
                raise ValueError('Missing external source image: ' + image.name)
        # Decoding is lazy. Reading pixels forces verification before save/export.
        try:
            if image.size[0] <= 0 or image.size[1] <= 0 or len(image.pixels) == 0:
                raise ValueError('Image has no decoded pixels')
        except Exception as exc:
            raise ValueError('Unreadable source image: ' + image.name) from exc


def correspondence(source, returned, tolerance=0.000002):
    """Prove position bijection modulo splits; never pick a nearest vertex."""
    if not math.isfinite(tolerance) or tolerance <= 0 or tolerance > 0.00001:
        raise ValueError('Unsafe coordinate tolerance')
    points = [(mi, vi, p) for mi, mesh in enumerate(source) for vi, p in enumerate(mesh['positions'])]
    buckets={}
    def cell(p): return tuple(math.floor(x/tolerance) for x in p)
    for mi,vi,p in points:
        if len(p)!=3 or any(not math.isfinite(x) for x in p): raise ValueError('Nonfinite source position')
        buckets.setdefault(cell(p),[]).append((mi,vi,p))
    mapping, seen = [], set()
    for mesh in returned:
        local = []
        for p in mesh['positions']:
            if len(p)!=3 or any(not math.isfinite(x) for x in p): raise ValueError('Nonfinite returned position')
            c=cell(p)
            nearby=[entry for dx in (-1,0,1) for dy in (-1,0,1) for dz in (-1,0,1) for entry in buckets.get((c[0]+dx,c[1]+dy,c[2]+dz),[])]
            candidates = [(mi, vi) for mi, vi, q in nearby if all(abs(a-b) <= tolerance for a,b in zip(p,q))]
            if len(candidates) != 1:
                raise ValueError('Altered or ambiguous geometry correspondence')
            local.append(candidates[0]); seen.add(candidates[0])
        mapping.append(local)
    if len(seen) != len(points):
        raise ValueError('Returned geometry removed source vertices')
    from collections import Counter
    original = Counter(tuple(sorted((mi,v) for v in tri)) for mi,m in enumerate(source) for tri in m['triangles'])
    external = Counter(tuple(sorted(mapping[mi][v] for v in tri)) for mi,m in enumerate(returned) for tri in m['triangles'])
    if original != external:
        prove_triangulation(source, external, tolerance)
    return mapping


def coordinate_transform(values):
    """Only an explicit proper rigid/uniform transform; never infer alignment."""
    from mathutils import Matrix
    if values is None: return Matrix.Identity(4)
    if not isinstance(values,list) or len(values)!=4 or any(not isinstance(r,list) or len(r)!=4 for r in values):
        raise ValueError('Coordinate transform must be a 4x4 matrix')
    if any(isinstance(x,bool) or not isinstance(x,(int,float)) or not math.isfinite(x) for row in values for x in row):
        raise ValueError('Coordinate transform must be finite')
    matrix=Matrix(values)
    if any(abs(matrix[3][i]-(1 if i==3 else 0))>1e-7 for i in range(4)):
        raise ValueError('Coordinate transform must be affine')
    linear=matrix.to_3x3(); columns=[linear.col[i] for i in range(3)]
    scale=sum(v.length for v in columns)/3
    if not 1e-6<=scale<=1e6 or linear.determinant()<=0:
        raise ValueError('Coordinate transform requires positive uniform scale and rotation')
    if any(abs(v.length-scale)>scale*1e-6 for v in columns) or any(abs(columns[i].dot(columns[j]))>scale*scale*1e-6 for i in range(3) for j in range(i)):
        raise ValueError('Coordinate transform rejects shear and nonuniform scale')
    return matrix


def prove_triangulation(source, external, tolerance):
    """Allow alternate diagonals only for convex planar quads with exact boundary."""
    from collections import Counter
    remaining=external.copy()
    def sub(a,b): return [x-y for x,y in zip(a,b)]
    def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
    def dot(a,b): return sum(x*y for x,y in zip(a,b))
    for mi,mesh in enumerate(source):
        polygons=mesh.get('polygons',mesh['triangles'])
        for poly in polygons:
            keys={(mi,v) for v in poly}
            matches=[tri for tri,count in remaining.items() for _ in range(count) if set(tri).issubset(keys)]
            if len(poly)==3:
                if len(matches)!=1: raise ValueError('Triangle surface changed')
            elif len(poly)==4:
                if len(matches)!=2: raise ValueError('Quad triangulation changed')
                p=[mesh['positions'][v] for v in poly]
                n=cross(sub(p[1],p[0]),sub(p[2],p[0])); length=math.sqrt(dot(n,n))
                if length<=1e-12 or abs(dot(sub(p[3],p[0]),n))/length>tolerance:
                    raise ValueError('Alternate triangulation requires planar nondegenerate quad')
                signs=[dot(cross(sub(p[(i+1)%4],p[i]),sub(p[(i+2)%4],p[(i+1)%4])),n) for i in range(4)]
                if any(x<=1e-12 for x in signs): raise ValueError('Alternate triangulation requires convex quad')
                boundary=Counter(tuple(sorted(((mi,poly[i]),(mi,poly[(i+1)%4])))) for i in range(4))
                edges=Counter(tuple(sorted((tri[i],tri[(i+1)%3]))) for tri in matches for i in range(3))
                if Counter({edge:count%2 for edge,count in edges.items() if count%2}) != boundary:
                    raise ValueError('Quad triangulation boundary changed')
            else:
                raise ValueError('Alternate triangulation only supports triangles and convex planar quads')
            for tri in matches:
                remaining[tri]-=1
                if remaining[tri]==0: del remaining[tri]
    if remaining: raise ValueError('Unexpected returned triangles')

def skin_report():
    import bpy
    rigs = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    if len(rigs) != 1:
        raise ValueError('Return requires exactly one armature')
    rig = rigs[0]
    if any(abs(b.matrix_basis[i][j]-(1 if i==j else 0))>1e-6 for b in rig.pose.bones for i in range(4) for j in range(4)): raise ValueError('Returned skeleton must be in rest pose')
    if any(b.constraints for b in rig.pose.bones): raise ValueError('Bone constraints unsupported')
    if any(not math.isfinite(x) for b in rig.data.bones for row in b.matrix_local for x in row) or any(b.length<1e-7 for b in rig.data.bones): raise ValueError('Invalid rest skeleton')
    bones = [{'name': b.name, 'parent': b.parent.name if b.parent else None, 'deform': b.use_deform,
              'head': list(b.head_local), 'tail': list(b.tail_local), 'matrix': [list(r) for r in b.matrix_local]} for b in rig.data.bones]
    weights = []
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH': continue
        mods = [m for m in obj.modifiers if m.type == 'ARMATURE']
        if len(mods) != 1 or mods[0].object != rig or not mods[0].use_vertex_groups or mods[0].use_bone_envelopes or mods[0].vertex_group or not mods[0].show_viewport or not mods[0].show_render:
            raise ValueError('Mesh must use returned armature vertex groups')
        groups = {g.index:g.name for g in obj.vertex_groups}
        rows=[]
        for v in obj.data.vertices:
            if any(not math.isfinite(g.weight) or g.weight<0 for g in v.groups): raise ValueError('Invalid skin weight value')
            row={groups[g.group]:float(g.weight) for g in v.groups if g.weight > 0}
            if not row or any(n not in rig.data.bones or not rig.data.bones[n].use_deform or not math.isfinite(w) or w > 1 for n,w in row.items()) or abs(sum(row.values())-1) > .001:
                raise ValueError('Invalid returned skin weights')
            rows.append(row)
        weights.append(rows)
    return rig, bones, weights


def run(req):
    import bpy
    if req.get('schemaVersion') != 1: raise ValueError('Unsupported request schema')
    operation=req['operation']; source=checked(req['sourcePath'], req['sourceSha256'])
    out=Path(req['outputDir']).resolve()
    if out.exists() and (not out.is_dir() or any(out.iterdir())): raise ValueError('Output directory must be fresh and empty')
    if source == out or out in source.parents: raise ValueError('Unsafe output location')
    load_scene(source)
    original=snapshot(static=True)
    validate_images()
    units={'system':bpy.context.scene.unit_settings.system, 'scaleLength':bpy.context.scene.unit_settings.scale_length}
    report={'schemaVersion':1, 'operation':operation, 'status':'complete', 'sourcePath':str(source), 'sourceSha256':sha(source), 'scene':{'meshes':original,'units':units,'axis':{'up':'Z','forward':'unverified'}}, 'files':[], 'checks':[]}
    def record(role,path): report['files'].append({'role':role,'path':str(path),'sha256':sha(path)})
    if operation == 'prepare':
        out.mkdir(parents=True,exist_ok=True)
        # FBX cannot embed GENERATED images with empty file paths. Materialize only
        # this in-memory working copy, and bind every dependency in the report.
        for index,image in enumerate(bpy.data.images):
            if image.source == 'GENERATED':
                image_path=out/('source-image-%04d.png' % index)
                image.filepath_raw=str(image_path); image.file_format='PNG'; image.save()
                image.source='FILE'; image.reload(); record('source-image',image_path)
            elif image.source == 'FILE' and image.packed_file:
                # Exporter reads a disk path even when Blender can render packed
                # pixels. Copy packed bytes exactly, avoiding color re-encoding.
                extension={'PNG':'.png','JPEG':'.jpg','TARGA':'.tga','TIFF':'.tif','OPEN_EXR':'.exr','BMP':'.bmp'}.get(image.file_format)
                if not extension: raise ValueError('Unsupported packed image format: '+image.name)
                image_path=out/('source-image-%04d%s' % (index,extension))
                image_path.write_bytes(bytes(image.packed_file.data))
                image.filepath_raw=str(image_path); record('source-image',image_path)
        # Pack external images into the immutable working copy; source stays untouched.
        bpy.ops.file.pack_all()
        for image in bpy.data.images:
            if image.source=='FILE' and not image.packed_file: raise ValueError('Source image not packed: '+image.name)
        blend=out/'source.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(blend), check_existing=False); record('source-scene',blend)
        bpy.ops.object.select_all(action='DESELECT')
        for o in bpy.context.scene.objects:
            if o.type == 'MESH': o.select_set(True)
        fbx=out/'handoff.fbx'
        bpy.ops.export_scene.fbx(filepath=str(fbx),use_selection=True,object_types={'MESH'},add_leaf_bones=False,bake_anim=False,path_mode='COPY',embed_textures=True,axis_forward='-Z',axis_up='Y')
        record('preparation-fbx',fbx)
        report['checks']=['staticSource','sourceHashBound','sourceScenePacked','noInputWrites']
        return report
    if operation not in ('inspect-return','import-return'): raise ValueError('Unknown operation')
    prep=checked(req['preparationReportPath'],req['preparationReportSha256'])
    prior=json.loads(prep.read_text(encoding='utf-8-sig'))
    if prior['operation']!='prepare' or prior['status']!='complete' or prior['sourceSha256']!=sha(source): raise ValueError('Preparation provenance mismatch')
    for entry in prior['files']: checked(entry['path'],entry['sha256'])
    prepared_scene=next((Path(e['path']) for e in prior['files'] if e['role']=='source-scene'),None)
    if not prepared_scene: raise ValueError('Missing packed immutable source scene')
    load_scene(prepared_scene)
    original=snapshot(static=True)
    if original != prior['scene']['meshes']: raise ValueError('Preparation scene metadata mismatch')
    returned=checked(req['returnedFbxPath'],req['returnedFbxSha256'])
    load_scene(returned); external=snapshot(); rig,bones,weights=skin_report()
    transform=coordinate_transform(req.get('sourceToReturnedMatrix'))
    inverse=transform.inverted()
    from mathutils import Vector
    aligned=[dict(mesh,positions=[list(inverse@Vector(p)) for p in mesh['positions']]) for mesh in external]
    mapping=correspondence(original,aligned,req.get('coordinateTolerance',0.000002))
    proven={}
    for mi,rows in enumerate(mapping):
        for vi,key in enumerate(rows):
            row=weights[mi][vi]
            if key in proven and (set(row)!=set(proven[key]) or any(abs(row[n]-proven[key][n])>1e-6 for n in row)):
                raise ValueError('Split vertices disagree on skin weights')
            proven[key]=row
    report.update({'returnedFbxPath':str(returned),'returnedFbxSha256':sha(returned),'bones':bones,'returnedMeshes':external,'correspondence':mapping,'weights':weights,'mappingHints':{'policy':'explicit-human-bone-mapping-required','boneNames':[b['name'] for b in bones]}})
    report['sourceToReturnedMatrix']=[list(row) for row in transform]
    report['checks']=['preparationHashBound','uniqueCoordinateCorrespondence','triangleMultisetExact','splitWeightsConsistent','normalizedSkin']
    report['checks'].append('coordinateTransformVerified')
    if operation=='import-return':
        # Keep external skeleton (including twist bones), reconstruct only original mesh data.
        out.mkdir(parents=True,exist_ok=True)
        skeleton=out/'external-skeleton.blend'
        rig_world=rig.matrix_world.copy()
        bpy.data.libraries.write(str(skeleton), {rig}, fake_user=True)
        rig_name=rig.name
        load_scene(prepared_scene)
        with bpy.data.libraries.load(str(skeleton), link=False) as (available, loaded):
            loaded.objects=[rig_name]
        rig_copy=loaded.objects[0]
        bpy.context.scene.collection.objects.link(rig_copy)
        bpy.context.view_layer.update()
        rig_copy.matrix_world=inverse@rig_world
        record('external-skeleton',skeleton)
        meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
        for mi,obj in enumerate(meshes):
            for group in list(obj.vertex_groups): obj.vertex_groups.remove(group)
            groups={b.name:obj.vertex_groups.new(name=b.name) for b in rig_copy.data.bones if b.use_deform}
            for vi in range(len(obj.data.vertices)):
                for name,weight in proven[(mi,vi)].items(): groups[name].add([vi],weight,'REPLACE')
            matrix=obj.matrix_world.copy(); obj.parent=rig_copy; obj.matrix_world=matrix
            mod=obj.modifiers.new('External rig','ARMATURE'); mod.object=rig_copy
        bpy.context.view_layer.update()
        restored=snapshot()
        for before,after in zip(original,restored):
            for key in ('polygons','uv','materialIndices','materials','id','partId'):
                if before[key]!=after[key]: raise ValueError('Original data preservation failed: '+key)
            if max((abs(a-b) for p,q in zip(before['positions'],after['positions']) for a,b in zip(p,q)),default=0)>0.000002:
                raise ValueError('Original rest geometry preservation failed')
        deps=bpy.context.evaluated_depsgraph_get()
        for mi,obj in enumerate(meshes):
            evaluated=obj.evaluated_get(deps)
            if any(abs(a-b)>0.000002 for vertex,point in zip(evaluated.data.vertices,original[mi]['positions']) for a,b in zip(evaluated.matrix_world@vertex.co,point)):
                raise ValueError('Returned skin does not preserve source rest geometry')
        bpy.ops.file.pack_all()
        blend=out/'rigged-original.blend'; bpy.ops.wm.save_as_mainfile(filepath=str(blend),check_existing=False); record('blend',blend)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes+[rig_copy]: obj.select_set(True)
        fbx=out/'rigged-original.fbx'
        bpy.ops.export_scene.fbx(filepath=str(fbx),use_selection=True,object_types={'MESH','ARMATURE'},add_leaf_bones=False,bake_anim=False,path_mode='COPY',embed_textures=True,axis_forward='-Z',axis_up='Y')
        record('fbx',fbx)
        glb=out/'rigged-original.glb'
        bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',use_selection=True,export_animations=False)
        record('glb',glb)
        report['checks'].append('originalMeshMaterialsUvRestored')
    return report


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--request',required=True); parser.add_argument('--report',required=True)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    target=Path(args.report).resolve()
    if target.exists(): raise ValueError('Report already exists')
    req=json.loads(Path(args.request).read_text(encoding='utf-8-sig'))
    try: result=run(req)
    except Exception as exc: result={'schemaVersion':1,'operation':req.get('operation'),'status':'blocked','sourceSha256':req.get('sourceSha256'),'error':str(exc),'files':[],'checks':[]}
    result['requestSha256']=sha(args.request)
    result['checks']=[{'id':c,'passed':True} if isinstance(c,str) else c for c in result.get('checks',[])]
    target.parent.mkdir(parents=True,exist_ok=True); target.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    if result['status']!='complete': raise SystemExit(1)

if __name__=='__main__': main()

"""Bounded, deterministic, offline planar boundary repair. No services or adoption."""
import bpy, bmesh, json, pathlib, sys, math
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree
from mathutils.geometry import tessellate_polygon
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from tripo_part_preservation import file_hash, digest, mesh_snapshot, material_snapshot
from graphics_glb import export_packed_glb

def cross(a,b,c): return float(np.cross(np.asarray(b)-a,np.asarray(c)-a))
def area(p): return sum(p[i][0]*p[(i+1)%len(p)][1]-p[(i+1)%len(p)][0]*p[i][1] for i in range(len(p)))/2

def inside(p, poly, eps):
    # Strict interior only; boundary contacts are legitimate.
    if any(abs(cross(a,b,p))<=eps and np.dot(np.asarray(p)-a,np.asarray(p)-b)<=eps for a,b in zip(poly,poly[1:]+poly[:1])): return False
    return sum((a[1]>p[1]) != (b[1]>p[1]) and p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0] for a,b in zip(poly,poly[1:]+poly[:1]))%2==1

def proper_cross(a,b,c,d,eps): return cross(a,b,c)*cross(a,b,d)<-eps*eps and cross(c,d,a)*cross(c,d,b)<-eps*eps

def project(points):
    p=np.asarray(points,dtype=float); scale=float(np.linalg.norm(np.ptp(p,axis=0)))
    if not np.isfinite(p).all() or scale<=1e-12: raise ValueError('degenerate boundary')
    _,s,v=np.linalg.svd(p-p.mean(axis=0)); n=v[-1]; eps=scale*1e-6
    if s[1]<=eps or max(abs((p-p[0])@n))>eps: raise ValueError('nonplanar boundary')
    axes=[i for i in range(3) if i!=int(np.argmax(abs(n)))]; flat=p[:,axes].tolist()
    if abs(area(flat))<=scale*scale*1e-10: raise ValueError('degenerate projected area')
    for i in range(len(flat)):
        for j in range(i+1,len(flat)):
            if np.linalg.norm(p[i]-p[j])<=eps: raise ValueError('duplicate boundary coordinates')
            if j not in (i+1,) and (i,j)!=(0,len(flat)-1) and (proper_cross(flat[i],flat[(i+1)%len(flat)],flat[j],flat[(j+1)%len(flat)],eps*eps) or any(abs(cross(a,b,c))<=eps*eps and np.dot(np.asarray(c)-a,np.asarray(c)-b)<=eps*eps for a,b,c in [(flat[i],flat[(i+1)%len(flat)],flat[j]),(flat[i],flat[(i+1)%len(flat)],flat[(j+1)%len(flat)]),(flat[j],flat[(j+1)%len(flat)],flat[i]),(flat[j],flat[(j+1)%len(flat)],flat[(i+1)%len(flat)])])): raise ValueError('self-crossing or touching boundary')
    return flat,n,axes,eps

def load(q):
    source=pathlib.Path(q['source']).resolve()
    if source.suffix.lower() not in ('.fbx','.blend') or file_hash(source)!=q['sourceSha256']: raise ValueError('source hash/type mismatch')
    if q.get('algorithmVersion')!='planar-v2': raise ValueError('unsupported algorithm version')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if source.suffix.lower()=='.blend': bpy.ops.wm.open_mainfile(filepath=str(source),load_ui=False)
    else: bpy.ops.import_scene.fbx(filepath=str(source),use_image_search=False)
    objects=list(bpy.context.scene.objects)
    if not objects or len(objects)>64 or any(o.type!='MESH' or o.modifiers or o.constraints or o.parent or o.vertex_groups or o.data.shape_keys for o in objects): raise ValueError('static independent meshes only; rigs, skin, morphs and modifiers unsupported')
    if bpy.data.armatures or bpy.data.actions or bpy.data.libraries or any(getattr(o,'animation_data',None) for o in bpy.data.user_map()): raise ValueError('dynamic or linked dependencies unsupported')
    if sum(len(o.data.polygons) for o in objects)>250000: raise ValueError('inspection face limit exceeded')
    if len(bpy.data.scenes)!=1 or len(bpy.data.objects)!=len(objects): raise ValueError('extra scenes or off-scene objects unsupported')
    material_snapshot() # Packed originals only.
    return sorted(objects,key=lambda o:o.name)

def boundaries(obj):
    mesh=obj.data;incidence={};directed={}
    for face in mesh.polygons:
        vs=list(face.vertices)
        for a,b in zip(vs,vs[1:]+vs[:1]):
            key=tuple(sorted((a,b)));incidence.setdefault(key,[]).append(face.index);directed[key]=(a,b)
    boundary_edges={key for key,faces in incidence.items() if len(faces)==1};graph={}
    if len(boundary_edges)>4096:raise ValueError('bounded boundary graph limit exceeded')
    for a,b in boundary_edges:graph.setdefault(a,set()).add(b);graph.setdefault(b,set()).add(a)
    def connected(edges):
        g={}
        for a,b in edges:g.setdefault(a,set()).add(b);g.setdefault(b,set()).add(a)
        unseen=set(g);parts=[]
        while unseen:
            todo=[min(unseen)];vertices=set(todo)
            while todo:
                for v in g[todo.pop()]:
                    if v not in vertices:vertices.add(v);todo.append(v)
            unseen-=vertices;parts.append((vertices,{e for e in edges if e[0] in vertices}))
        return sorted(parts,key=lambda item:min(item[0]))
    result=[]
    for component,edges in connected(boundary_edges):
        component_id=digest([obj.name,sorted(component),sorted(edges)])[:24]
        core={v:set(graph[v]) for v in component};leaves=sorted(v for v in core if len(core[v])<2)
        while leaves:
            v=leaves.pop()
            if v not in core:continue
            for neighbor in list(core[v]):
                core[neighbor].discard(v)
                if len(core[neighbor])<2:leaves.append(neighbor)
            del core[v]
        core_edges={tuple(sorted((a,b))) for a in core for b in core[a]};parts=[]
        for vertices,partedges in connected(core_edges):
            if len(vertices)>64 or any(len(core[v])!=2 for v in vertices):
                parts.append((sorted(vertices),partedges,'open-chain',['ambiguous branched core; explicit bounded simple loop unavailable']))
                continue
            ordered=[min(vertices)];previous=None;current=ordered[0]
            while True:
                nxt=min(v for v in core[current] if v!=previous)
                if nxt==ordered[0]:break
                ordered.append(nxt);previous,current=current,nxt
            if directed[tuple(sorted(ordered[:2]))]==tuple(ordered[:2]):ordered=[ordered[0]]+list(reversed(ordered[1:]))
            reasons=[]
            if any(directed[tuple(sorted((a,b)))]!=(b,a) for a,b in zip(ordered,ordered[1:]+ordered[:1])):reasons.append('inconsistent source winding')
            parts.append((ordered,partedges,'loop' if core_edges==edges else 'subcycle',reasons))
        for vertices,partedges in connected(edges-core_edges):parts.append((sorted(vertices),partedges,'open-chain',['open boundary chain retained']))
        for vertices,partedges,kind,reasons in sorted(parts,key=lambda item:(min(item[0]),item[2],item[0])):
            world=[list(obj.matrix_world@mesh.vertices[v].co) for v in vertices];measurement={}
            if kind!='open-chain':
                try:
                    _,normal,_,epsilon=project(world);cloud=np.array(world);diagonal=float(np.linalg.norm(np.ptp(cloud,axis=0)));deviation=float(max(abs((cloud-cloud[0])@normal)))
                    measurement={'planarityRelativeTolerance':1e-6,'planarityAbsoluteTolerance':epsilon,'maxPlaneDeviation':deviation,'boundaryDiagonal':diagonal,'relativePlaneDeviation':deviation/diagonal}
                except ValueError as error:reasons.append(str(error))
            adjacent=sorted({incidence[e][0] for e in partedges});materials=sorted({mesh.polygons[i].material_index for i in adjacent})
            if len(materials)!=1:reasons.append('ambiguous boundary material')
            # Edge sets and vertex-coordinate maps are canonical under traversal reversal/rotation.
            canonical_world=[[v,list(obj.matrix_world@mesh.vertices[v].co)] for v in sorted(vertices)]
            identity=digest([obj.name,sorted(partedges),canonical_world])[:24]
            result.append({'id':identity,'number':len(result)+1,'kind':kind,'componentId':component_id,'edgeVertexPairs':[list(e) for e in sorted(partedges)],'conflictsWith':[],
                'vertexIndices':vertices,'worldVertices':world,'polyline':world+([world[0]] if kind!='open-chain' else []),'status':'blocked' if reasons else 'eligible','reasons':reasons,
                'adjacentFaces':adjacent,'materialIndex':materials[0] if len(materials)==1 else None,'materialOptions':['preserve','reuse-existing-pattern'] if not reasons else [],'measurement':measurement})
    for a in result:
        if a['status']!='eligible':continue
        flat,normal,axes,eps=project(a['worldVertices']);origin=np.array(a['worldVertices'][0])
        for b in result:
            if b is a or b['kind']=='open-chain':continue
            points=np.array(b['worldVertices'])
            if max(abs((points-origin)@normal))<=eps and any(inside(v,flat,eps*eps) for v in points[:,axes].tolist()):
                a['status']='blocked';a['reasons'].append('nested coplanar boundary');b['status']='blocked';b['reasons'].append('nested coplanar boundary')
    return result

def triangles(points):
    flat,_,_,eps=project(points)
    if len(points)==3 or len(points)==4 and all(cross(flat[i-1],flat[i],flat[(i+1)%4])*area(flat)>eps**4 for i in range(4)): return [list(range(len(points)))]
    vectors=[Vector(p) for p in points]
    remaining=list(range(len(points)));result=[];orientation=1 if area(flat)>0 else -1
    while len(remaining)>3:
        found=False
        for position,b in enumerate(remaining):
            a=remaining[position-1];c=remaining[(position+1)%len(remaining)]
            if orientation*cross(flat[a],flat[b],flat[c])<=eps*eps: continue
            if any(all(orientation*cross(flat[x],flat[y],flat[v])>=-eps*eps for x,y in ((a,b),(b,c),(c,a))) for v in remaining if v not in (a,b,c)): continue
            rest=remaining[:position]+remaining[position+1:]
            if abs(area([flat[i] for i in rest]))<=eps*eps: continue
            result.append([a,b,c]);remaining=rest;found=True;break
        if not found: raise ValueError('bounded ear triangulation cannot preserve all boundary vertices')
    result.append(remaining)
    if len(result)!=len(points)-2 or any(len(set(t))!=3 or area([flat[i] for i in t])*area(flat)<=0 for t in result) or abs(sum(abs(area([flat[i] for i in t])) for t in result)-abs(area(flat)))>max(abs(area(flat))*1e-7,eps*eps): raise ValueError('triangulation failed independent winding/coverage validation')
    incidence={}
    for tri in result:
        center=np.mean([flat[i] for i in tri],axis=0).tolist()
        if not inside(center,flat,eps*eps): raise ValueError('triangle lies outside boundary')
        for a,b in zip(tri,tri[1:]+tri[:1]): incidence.setdefault(tuple(sorted((a,b))),[]).append((a,b))
    outline={tuple(sorted((i,(i+1)%len(points)))):(i,(i+1)%len(points)) for i in range(len(points))}
    if any(incidence.get(key)!=[direction] for key,direction in outline.items()) or any(len(edges)!=2 or edges[0]!=tuple(reversed(edges[1])) for key,edges in incidence.items() if key not in outline): raise ValueError('triangulation boundary/internal incidence invalid')
    return result

def intersects(new,old,eps,shared=()):
    # Triangle/triangle SAT in 3D, with extra in-plane axes for coplanarity.
    a=np.asarray(new); b=np.asarray(old); ea=np.roll(a,-1,axis=0)-a;eb=np.roll(b,-1,axis=0)-b
    na=np.cross(ea[0],ea[1]);nb=np.cross(eb[0],eb[1]); axes=[na,nb]+[np.cross(x,y) for x in ea for y in eb]
    coplanar=np.linalg.norm(np.cross(na,nb))<=np.linalg.norm(na)*np.linalg.norm(nb)*1e-7 and max(abs((b-a[0])@(na/np.linalg.norm(na))))<=eps
    if coplanar: axes += [np.cross(na,x) for x in list(ea)+list(eb)]
    touch=False
    for axis in axes:
        norm=np.linalg.norm(axis)
        if norm<=1e-20: continue
        pa=a@(axis/norm);pb=b@(axis/norm)
        if min(max(pa),max(pb))-max(min(pa),min(pb)) < -eps: return False
        if coplanar and min(max(pa),max(pb))-max(min(pa),min(pb))<=eps: touch=True
    def permitted(point):
        if any(np.linalg.norm(point-np.asarray(v))<=eps for v in shared): return True
        if len(shared)==2:
            x,y=map(np.asarray,shared);d=y-x;t=float(np.dot(point-x,d)/np.dot(d,d))
            return -eps<=t<=1+eps and np.linalg.norm(point-(x+t*d))<=eps
        return False
    if coplanar and touch:
        contact=[]
        for triangle,other in ((a,b),(b,a)):
            for point in triangle:
                for x,y in zip(other,np.roll(other,-1,axis=0)):
                    d=y-x;t=float(np.dot(point-x,d)/max(np.dot(d,d),1e-30))
                    if -eps<=t<=1+eps and np.linalg.norm(point-(x+t*d))<=eps: contact.append(point)
        return not (contact and all(permitted(v) for v in contact))
    if not coplanar:
        # SAT includes contact. Intersect the old triangle with the patch plane,
        # then clip that segment against the patch triangle's exact half-planes.
        # Only resulting shared topology points/edges may be permitted.
        normal=na/np.linalg.norm(na);distances=(b-a[0])@normal;cuts=[]
        for point,distance in zip(b,distances):
            if abs(distance)<=eps:cuts.append(point)
        for i in range(3):
            j=(i+1)%3
            if distances[i]*distances[j]<0:cuts.append(b[i]+(b[j]-b[i])*(-distances[i])/(distances[j]-distances[i]))
        unique=[]
        for point in cuts:
            if not any(np.linalg.norm(point-other)<=eps for other in unique):unique.append(point)
        if not unique:return False
        if len(unique)>2:return True
        start=unique[0];end=unique[-1];axes2=[i for i in range(3) if i!=int(np.argmax(abs(normal)))];flat=a[:,axes2].tolist();orientation=1 if area(flat)>0 else -1
        lo,hi=0.,1.
        for i in range(3):
            x,y=np.array(flat[i]),np.array(flat[(i+1)%3]);edge=y-x
            offset=float(orientation*np.cross(edge,start[axes2]-x));slope=float(orientation*np.cross(edge,end[axes2]-start[axes2]))
            if abs(slope)<=1e-30:
                if offset < -eps*np.linalg.norm(edge):return False
            elif slope>0:lo=max(lo,-offset/slope)
            else:hi=min(hi,-offset/slope)
        length=float(np.linalg.norm(end-start));parameter_epsilon=eps/max(length,eps)
        if hi<lo-parameter_epsilon:return False
        lo=max(0.,min(1.,lo));hi=max(lo,min(1.,hi));first=start+(end-start)*lo;last=start+(end-start)*hi
        return not (permitted(first) and permitted(last))
    return True

def uv_mapping(obj,boundary,policy):
    mesh=obj.data; layer=mesh.uv_layers.active
    if layer is None or len(mesh.uv_layers)!=1 or not layer.active_render: raise ValueError('textured repair requires one unambiguous UV layer')
    points=[list(mesh.vertices[i].co) for i in boundary['vertexIndices']];flat,n,axes,eps=project(points)
    donors=[]
    for f in mesh.polygons:
        if f.material_index!=boundary['materialIndex']: continue
        coords=np.array([list(mesh.vertices[i].co) for i in f.vertices]); uv=np.array([list(layer.data[i].uv) for i in f.loop_indices])
        if len(coords)<3 or abs(area(uv.tolist()))<1e-10: continue
        try: _,fn,_,_=project(coords)
        except ValueError: continue
        if abs(float(fn@n))<.999999: continue
        x=np.column_stack((coords[:,axes],np.ones(len(coords)))); mapping,_,rank,_=np.linalg.lstsq(x,uv,rcond=None)
        if rank!=3 or max(np.linalg.norm(x@mapping-uv,axis=1))>1e-6: continue
        if policy=='preserve' and (f.index not in boundary['adjacentFaces'] or max(abs((coords-np.array(points[0]))@n))>eps): continue
        donors.append((f,mapping,uv))
    if not donors: raise ValueError('no compatible affine UV donor')
    if policy=='preserve':
        mapping=donors[0][1]
        if any(np.max(abs(m-mapping))>1e-5 for _,m,_ in donors): raise ValueError('inconsistent connected affine UVs')
        values=np.column_stack((np.array(points)[:,axes],np.ones(len(points))))@mapping
        patch=values.tolist()
        for f in mesh.polygons:
            uv=[list(layer.data[i].uv) for i in f.loop_indices]
            if any(inside(p,uv,1e-7) for p in patch) or any(inside(p,patch,1e-7) for p in uv) or inside(np.mean(patch,axis=0).tolist(),uv,1e-7) or any(proper_cross(a,b,c,d,1e-7) for a,b in zip(patch,patch[1:]+patch[:1]) for c,d in zip(uv,uv[1:]+uv[:1])): raise ValueError('affine extension overlaps existing UVs')
    elif policy=='reuse-existing-pattern':
        # Explicit shared pattern: only same corner count and similar planar shape.
        candidates=[]
        for f,m,uv in donors:
            if len(f.vertices)!=len(points): continue
            donor=np.array([list(mesh.vertices[i].co) for i in f.vertices])[:,axes]; target=np.array(flat)
            donor=(donor-donor.mean(axis=0))/max(np.linalg.norm(donor-donor.mean(axis=0)),1e-12); target=(target-target.mean(axis=0))/max(np.linalg.norm(target-target.mean(axis=0)),1e-12)
            for shift in range(len(points)):
                for reverse in (False,True):
                    order=np.roll(np.arange(len(points)),shift)
                    if reverse: order=order[::-1]
                    x=donor[order];u,_,vt=np.linalg.svd(x.T@target);err=np.linalg.norm(x@(u@vt)-target)
                    if err<1e-5: candidates.append((f.index,shift,reverse,uv[order]))
        if not candidates: raise ValueError('no shape-compatible existing pattern donor')
        values=sorted(candidates,key=lambda c:c[:3])[0][3]
    else: raise ValueError('unsupported material policy')
    if abs(area(values.tolist()))<=1e-10 or not np.isfinite(values).all() or np.min(values)<0 or np.max(values)>1: raise ValueError('invalid patch UV')
    return values.tolist()

def boundary_intersection_preflight(obj,boundary,objects):
    candidate=[]
    for local in triangles(boundary['worldVertices']):
        ids=[boundary['vertexIndices'][i] for i in local];points=[list(obj.matrix_world@obj.data.vertices[i].co) for i in ids]
        for tri in tessellate_polygon([[Vector(v) for v in points]]):
            order=[v if isinstance(v,int) else min(range(len(points)),key=lambda i:math.dist(points[i],v)) for v in tri]
            candidate.append(([points[i] for i in order],[ids[i] for i in order]))
    count=sum(sum(len(f.vertices)-2 for f in o.data.polygons) for o in objects)
    if len(candidate)*count>2000000: raise ValueError('bounded intersection validation budget exceeded')
    extent=float(np.linalg.norm(np.ptp(np.array(boundary['worldVertices']),axis=0)));eps=extent*1e-7;conflicts=[]
    for other in objects:
        other.data.calc_loop_triangles()
        for tri in other.data.loop_triangles:
            old=[list(other.matrix_world@other.data.vertices[i].co) for i in tri.vertices]
            if any(intersects(points,old,eps,[list(obj.matrix_world@obj.data.vertices[v].co) for v in set(ids)&set(tri.vertices)] if other==obj else []) for points,ids in candidate):
                conflicts.append({'meshId':str(other.get('partsmith_id') or other.name),'faceIndex':tri.polygon_index})
    unique={ (c['meshId'],c['faceIndex']) for c in conflicts }
    return {'passed':not conflicts,'intersectionTolerance':eps,'conflictingFaces':[{'meshId':m,'faceIndex':f} for m,f in sorted(unique)]}

def attributes(mesh):
    result={}
    for attr in mesh.attributes:
        if attr.name.startswith('.select_') or attr.name in ('position','.edge_verts','.corner_vert','.corner_edge'): continue
        values=[]
        for item in attr.data:
            if hasattr(item,'value'): value=item.value if isinstance(item.value,(int,float,bool,str)) else list(item.value)
            elif hasattr(item,'vector'): value=list(item.vector)
            elif hasattr(item,'color'): value=list(item.color)
            else: raise ValueError('unsupported geometry attribute')
            values.append(value)
        result[attr.name]=(attr.domain,attr.data_type,values)
    return result

def run(q):
    objects=load(q); before={o.name:mesh_snapshot(o) for o in objects}; materials=material_snapshot()
    textured=bool(materials['textures']); records=[]; internals={};old_attributes={o.name:attributes(o.data) for o in objects};old_edge_keys={o.name:[tuple(sorted(e.vertices)) for e in o.data.edges] for o in objects}
    for obj in objects:
        meshid=str(obj.get('partsmith_id') or obj.name)
        if meshid in internals: raise ValueError('ambiguous mesh identity')
        bs=boundaries(obj)
        for b in bs:
            if b['status']=='eligible':
                options=[]
                try: ts=triangles(b['worldVertices'])
                except ValueError as error:
                    b['status']='blocked';b['reasons'].append(str(error));b['materialOptions']=[];continue
                try: b['intersectionPreflight']=boundary_intersection_preflight(obj,b,objects)
                except ValueError as error:
                    b['status']='blocked';b['reasons'].append(str(error));b['materialOptions']=[];continue
                if not b['intersectionPreflight']['passed']:
                    b['status']='blocked';b['reasons'].append('patch intersects existing surface');b['materialOptions']=[];continue
                b['addedFaces']=len(ts);b['addedQuads']=sum(len(t)==4 for t in ts);b['addedTriangles']=sum(len(t)==3 for t in ts);b['gameTriangles']=sum(len(t)-2 for t in ts)
                for policy in (('preserve','reuse-existing-pattern') if textured else ('preserve',)):
                    try:
                        if textured: uv_mapping(obj,b,policy)
                        options.append(policy)
                    except ValueError: pass
                b['materialOptions']=options
                if not options: b['status']='blocked';b['reasons'].append('no compatible UV material continuation')
        records.append({'meshId':meshid,'name':obj.name,'boundaries':bs,'vertices':len(obj.data.vertices),'faces':len(obj.data.polygons)})
        internals[meshid]=(obj,bs)
    inspection=digest([q['sourceSha256'],records,'planar-v2'])
    report={k:q.get(k) for k in ('identity','sourceVersionId','sourceSha256','algorithmVersion','meshId','selectedBoundaryIds','keptBoundaryIds','materialPolicy')}
    report.update(schemaVersion=1,mode=q['mode'],passed=True,inspectionId=inspection,meshes=records,localOnly=True,modelTurns=0,paidSubmissions=0,visualQualityVerified=False)
    if q['mode']=='repair':
        if q.get('inspectionId')!=inspection: raise ValueError('inspection identity changed')
        if q.get('meshId') not in internals: raise ValueError('explicit mesh selection required')
        obj,bs=internals[q['meshId']]; selected=q.get('selectedBoundaryIds',[]);kept=q.get('keptBoundaryIds',[])
        if not selected or len(set(selected))!=len(selected) or set(selected)&set(kept) or set(selected+kept)!={b['id'] for b in bs}: raise ValueError('every boundary needs explicit repair/keep choice')
        chosen=[b for b in bs if b['id'] in selected]
        for i,boundary in enumerate(chosen):
            edges={tuple(e) for e in boundary['edgeVertexPairs']}
            if any(edges & {tuple(e) for e in other['edgeVertexPairs']} or other['id'] in boundary['conflictsWith'] for other in chosen[:i]):raise ValueError('selected boundaries have conflicting edges')
        def edge_incidence(mesh):
            counts={}
            for face in mesh.polygons:
                vertices=list(face.vertices)
                for a,b in zip(vertices,vertices[1:]+vertices[:1]):
                    key=tuple(sorted((a,b)));counts[key]=counts.get(key,0)+1
            return counts
        old_incidence=edge_incidence(obj.data)
        retained_edges={tuple(e) for b in bs if b['id'] in kept for e in b['edgeVertexPairs']}
        patches=[]; uvvalues={}
        for b in bs:
            if b['id'] not in selected: continue
            if b['status']!='eligible' or q.get('materialPolicy','preserve') not in b['materialOptions']: raise ValueError('selected boundary blocked')
            if textured: uvvalues[b['id']]=uv_mapping(obj,b,q.get('materialPolicy','preserve'))
            for indices in triangles(b['worldVertices']): patches.append((b,[b['vertexIndices'][i] for i in indices]))
        # Independently compare triangulated patches against all original meshes.
        candidate=[];candidate_indices=[]
        for b,indices in patches:
            ps=[list(obj.matrix_world@obj.data.vertices[i].co) for i in indices]
            for tri in tessellate_polygon([[Vector(p) for p in ps]]):
                local=[v if isinstance(v,int) else min(range(len(ps)),key=lambda i:math.dist(ps[i],v)) for v in tri]
                candidate.append([ps[v] for v in local]);candidate_indices.append([indices[v] for v in local])
        extent=max(np.linalg.norm(np.ptp(np.array(b['worldVertices']),axis=0)) for b,_ in patches);eps=extent*1e-7
        if len(candidate)*sum(sum(len(f.vertices)-2 for f in o.data.polygons) for o in objects)>2000000: raise ValueError('bounded intersection validation budget exceeded; select fewer boundaries')
        for other in objects:
            other.data.calc_loop_triangles()
            for tri in other.data.loop_triangles:
                old=[list(other.matrix_world@other.data.vertices[i].co) for i in tri.vertices]
                if any(intersects(p,old,eps,[list(obj.matrix_world@obj.data.vertices[v].co) for v in set(ids)&set(tri.vertices)] if other==obj else []) for p,ids in zip(candidate,candidate_indices)): raise ValueError('patch intersects existing surface')
        for i,p in enumerate(candidate):
            if any(intersects(p,t,eps,[list(obj.matrix_world@obj.data.vertices[v].co) for v in set(candidate_indices[i])&set(candidate_indices[j])]) for j,t in enumerate(candidate[:i])): raise ValueError('new patch triangles overlap')
        bm=bmesh.new();bm.from_mesh(obj.data);bm.verts.ensure_lookup_table();oldfaces=len(obj.data.polygons)
        for b,indices in patches:
            f=bm.faces.new([bm.verts[i] for i in indices]);f.material_index=b['materialIndex']
        bm.to_mesh(obj.data);bm.free();obj.data.update()
        new_incidence=edge_incidence(obj.data)
        if any(new_incidence.get(e)!=old_incidence[e] for e in retained_edges):raise ValueError('kept boundary edge incidence changed')
        if any(new_incidence.get(tuple(e))!=old_incidence[tuple(e)]+1 for b in chosen for e in b['edgeVertexPairs']):raise ValueError('selected boundary edge incidence invalid')
        current=mesh_snapshot(obj);original=before[obj.name];loops=sum(map(len,original['polygons']))
        for k in ('positions','matrix','stableId','partId','materialSlots'):
            if current[k]!=original[k]: raise ValueError('original identity/geometry changed: '+k)
        if current['polygons'][:oldfaces]!=original['polygons'] or current['faceMaterials'][:oldfaces]!=original['faceMaterials']: raise ValueError('old faces changed')
        for old,new in zip(original['uv']['layers'],current['uv']['layers']):
            if old['values']!=new['values'][:loops]: raise ValueError('old UV changed')
        if textured:
            for f,(b,indices) in zip(list(obj.data.polygons)[oldfaces:],patches):
                for li,vi in zip(f.loop_indices,f.vertices): obj.data.uv_layers.active.data[li].uv=uvvalues[b['id']][b['vertexIndices'].index(vi)]
        else:
            bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
            layer=obj.data.uv_layers.new(name='PlanarRepairUV');obj.data.uv_layers.active=layer;layer.active_render=True
            bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(island_margin=.02);bpy.ops.object.mode_set(mode='OBJECT')
        # BMesh/UV edit may reorder edges and reset their built-in sharp flags.
        # Restore original edge-domain values by immutable vertex-pair identity.
        edges_by_key={tuple(sorted(e.vertices)):e.index for e in obj.data.edges}
        for name,(domain,kind,values) in old_attributes[obj.name].items():
            if domain!='EDGE': continue
            attr=obj.data.attributes.get(name) or obj.data.attributes.new(name=name,type=kind,domain=domain)
            for key,value in zip(old_edge_keys[obj.name],values):
                if key not in edges_by_key: raise ValueError('original edge removed')
                item=attr.data[edges_by_key[key]]
                if hasattr(item,'value'): item.value=value
                elif hasattr(item,'vector'): item.vector=value
                elif hasattr(item,'color'): item.color=value
                else: raise ValueError('unsupported preserved edge attribute')
        for name,(domain,kind,values) in old_attributes[obj.name].items():
            if domain=='EDGE' or name=='custom_normal': continue
            attr=obj.data.attributes.get(name) or obj.data.attributes.new(name=name,type=kind,domain=domain)
            if len(attr.data)<len(values): raise ValueError('original attribute domain shortened: '+name)
            for item,value in zip(attr.data,values):
                if hasattr(item,'value'): item.value=value
                elif hasattr(item,'vector'): item.vector=value
                elif hasattr(item,'color'): item.color=value
                else: raise ValueError('unsupported preserved attribute')
        if original['customNormals']:
            normals=[list(item.vector) for item in obj.data.corner_normals]
            obj.data.normals_split_custom_set(original['normals']+normals[loops:])
            packed=old_attributes[obj.name].get('custom_normal')
            if packed:
                attr=obj.data.attributes.get('custom_normal')
                for item,value in zip(attr.data,packed[2]): item.value=value
                obj.data.update()
        # Validate preservation after every UV/material mutation.
        final=mesh_snapshot(obj)
        for old,new in zip(original['uv']['layers'],final['uv']['layers']):
            if old['name']!=new['name'] or old['values']!=new['values'][:loops]: raise ValueError('post-operation original UV changed')
        if final['smooth'][:oldfaces]!=original['smooth'] or final['customNormals']!=original['customNormals']: raise ValueError('original shading changed')
        if original['customNormals'] and any(math.dist(a,b)>1e-6 for a,b in zip(original['normals'],final['normals'][:loops])): raise ValueError('original custom corner normals changed max='+str(max(math.dist(a,b) for a,b in zip(original['normals'],final['normals'][:loops]))))
        normal_max_deviation=max((math.dist(a,b) for a,b in zip(original['normals'],final['normals'][:loops])),default=0.0) if original['customNormals'] else None
        after_attributes=attributes(obj.data)
        for name,(domain,kind,values) in old_attributes[obj.name].items():
            if name not in after_attributes or after_attributes[name][:2]!=(domain,kind): raise ValueError('original custom attribute changed: '+name)
            retained=[after_attributes[name][2][edges_by_key[key]] for key in old_edge_keys[obj.name]] if domain=='EDGE' else after_attributes[name][2][:len(values)]
            if retained!=values: raise ValueError('original custom attribute changed: '+name)
        if materials!=material_snapshot() or any(mesh_snapshot(o)!=before[o.name] for o in objects if o!=obj): raise ValueError('other mesh or material changed')
        for other in objects:
            if other!=obj and (not other.data.uv_layers.active or any(abs(area([list(other.data.uv_layers.active.data[i].uv) for i in f.loop_indices]))<1e-12 for f in other.data.polygons)): raise ValueError('unselected mesh lacks valid export UV; prepare it separately')
        output=pathlib.Path(q['output']).resolve();output.mkdir(parents=True,exist_ok=True)
        if any(output.iterdir()): raise ValueError('output must be empty')
        bpy.ops.wm.save_as_mainfile(filepath=str(output/'asset.blend'),compress=False)
        # Export copies carry only their active UV, preserving editable original layers.
        bpy.ops.object.select_all(action='DESELECT');copies=[];original_names=[]
        for original_obj in objects:
            objectname,meshname=original_obj.name,original_obj.data.name;original_names.append((original_obj,objectname,meshname))
            original_obj.name=objectname+'__planar_source';original_obj.data.name=meshname+'__planar_source'
            copy=original_obj.copy();copy.data=original_obj.data.copy();copy.name=objectname;copy.data.name=meshname;bpy.context.collection.objects.link(copy);copies.append(copy);copy.select_set(True)
            active=copy.data.uv_layers.active.name if copy.data.uv_layers.active else None
            for layername in [layer.name for layer in copy.data.uv_layers]:
                if layername!=active: copy.data.uv_layers.remove(copy.data.uv_layers[layername])
            if copy.data.uv_layers: copy.data.uv_layers[0].active_render=True
        bpy.context.view_layer.objects.active=copies[0]
        export_triangles=[]
        for export_obj in copies:
            export_obj.data.calc_loop_triangles();uv=export_obj.data.uv_layers.active
            for tri in export_obj.data.loop_triangles:
                export_triangles.append({'world':[list(export_obj.matrix_world@export_obj.data.vertices[i].co) for i in tri.vertices],'uv':[list(uv.data[i].uv) for i in tri.loops],'material':export_obj.data.materials[tri.material_index].name if tri.material_index<len(export_obj.data.materials) and export_obj.data.materials[tri.material_index] else None})
        expected=[mesh_snapshot(o) for o in copies]
        expected_triangles=sum(sum(len(f)-2 for f in snap['polygons']) for snap in expected)
        bpy.ops.export_scene.fbx(filepath=str(output/'asset.fbx'),use_selection=True,object_types={'MESH'},use_mesh_modifiers=False,use_triangles=False,use_custom_props=True,bake_anim=False,path_mode='COPY',embed_textures=True)
        glb_images=export_packed_glb(output/'asset.glb',use_selection=True,use_active_scene=True,export_animations=False,export_extras=True)
        for copy in copies:
            mesh=copy.data;bpy.data.objects.remove(copy,do_unlink=True);bpy.data.meshes.remove(mesh)
        for original_obj,objectname,meshname in original_names: original_obj.name=objectname;original_obj.data.name=meshname
        # Actual independent exporter reloads, ensuring all exported polygons have UV area.
        for suffix in ('fbx','glb'):
            bpy.ops.wm.read_factory_settings(use_empty=True)
            if suffix=='fbx': bpy.ops.import_scene.fbx(filepath=str(output/'asset.fbx'),use_image_search=False)
            else: bpy.ops.import_scene.gltf(filepath=str(output/'asset.glb'))
            imported=[o for o in bpy.context.scene.objects if o.type=='MESH']
            if len(imported)!=len(expected) or not imported: raise ValueError('export mesh count changed')
            unmatched=list(expected)
            for imported_obj in imported:
                actual=mesh_snapshot(imported_obj)
                matches=[s for s in unmatched if len(s['positions'])==len(actual['positions']) and max(math.dist(a,b) for a,b in zip(s['world'],actual['world']))<=max(extent*2e-6,1e-7)] if suffix=='fbx' else unmatched
                if suffix=='fbx':
                    if len(matches)!=1: raise ValueError('FBX world geometry changed or ambiguous')
                    source_snap=matches[0];unmatched.remove(source_snap)
                    if actual['polygons']!=source_snap['polygons'] or actual['uv']!=source_snap['uv'] or actual['faceMaterials']!=source_snap['faceMaterials'] or actual['stableId']!=source_snap['stableId']: raise ValueError('FBX indexed geometry, UV, material or identity changed')
            if sum(sum(len(f.vertices)-2 for f in o.data.polygons) for o in imported)!=expected_triangles: raise ValueError('export triangle count changed')
            if suffix=='fbx' and textured:
                for image in bpy.data.images:
                    if image.source=='FILE' and not image.packed_file:
                        imagepath=pathlib.Path(bpy.path.abspath(image.filepath)).resolve()
                        if not imagepath.is_relative_to(output) or not imagepath.is_file(): raise ValueError('FBX external texture escaped derivative output')
                        image.pack()
                texture_key=lambda x:(x['sha256'],tuple(x['size']),x['colorSpace'])
                if sorted(map(texture_key,material_snapshot()['textures']))!=sorted(map(texture_key,materials['textures'])): raise ValueError('FBX packed texture bytes or color space changed')
            if suffix=='glb':
                coordinates=sorted({tuple(v) for t in export_triangles for v in t['world']});tree=KDTree(len(coordinates))
                for i,v in enumerate(coordinates): tree.insert(v,i)
                tree.balance();groups={}
                for t in export_triangles:
                    key=tuple(sorted(tree.find(v)[1] for v in t['world']));groups.setdefault(key,[]).append(t)
                for loaded_obj in imported:
                    loaded_obj.data.calc_loop_triangles();layer=loaded_obj.data.uv_layers.active
                    if layer is None: raise ValueError('GLB UV lost')
                    for tri in loaded_obj.data.loop_triangles:
                        points=[list(loaded_obj.matrix_world@loaded_obj.data.vertices[i].co) for i in tri.vertices];uvs=[list(layer.data[i].uv) for i in tri.loops]
                        near=[tree.find(v) for v in points]
                        if any(x[2]>max(extent*2e-6,1e-7) for x in near): raise ValueError('GLB world vertex changed')
                        key=tuple(sorted(x[1] for x in near));matches=[]
                        actualmat=loaded_obj.data.materials[tri.material_index].name if tri.material_index<len(loaded_obj.data.materials) and loaded_obj.data.materials[tri.material_index] else None
                        for t in groups.get(key,[]):
                            if t['material'] and actualmat!=t['material']: continue
                            for shift in range(3):
                                order=[(i+shift)%3 for i in range(3)]
                                if all(math.dist(points[i],t['world'][order[i]])<=max(extent*2e-6,1e-7) and math.dist(uvs[i],t['uv'][order[i]])<=2e-6 for i in range(3)): matches.append(t);break
                        if not matches: raise ValueError('GLB triangle winding, UV or material assignment changed')
                        groups[key].remove(matches[0])
                if any(groups.values()): raise ValueError('GLB lost expected triangles')
            for o in imported:
                layer=o.data.uv_layers.active
                if layer is None or any(abs(area([list(layer.data[i].uv) for i in f.loop_indices]))<1e-12 for f in o.data.polygons): raise ValueError('export contains invalid UV faces')
        report.update(originalFaces=oldfaces,addedFaces=len(patches),faces=oldfaces+len(patches),preservedVertices=len(original['positions']),customNormalMaxDeviation=normal_max_deviation,customNormalTolerance=1e-6,glbImages=glb_images,textures=materials['textures'],tolerance={'planarityRelative':1e-6,'intersectionRelative':1e-7,'exportRelative':2e-6,'exportAbsoluteFloor':1e-7,'uvAbsolute':2e-6},files=['asset.blend','asset.fbx','asset.glb','report.json'],checks={'staticOnly':True,'appendOnly':True,'oldVerticesPreserved':True,'oldUVLayersPreserved':True,'oldCustomAttributesPreserved':True,'oldCustomNormalsPreserved':True,'otherMeshesPreserved':True,'materialsAndImagesPreserved':True,'intersectionValidation':True,'keptBoundaryEdgesPreserved':True,'fbxRoundTrip':True,'glbRoundTrip':True},newUvLayerGenerated=not textured,warnings=['Local candidate; inspect appearance before adoption.'])
    elif q['mode']!='inspect': raise ValueError('unsupported mode')
    if file_hash(q['source'])!=q['sourceSha256']: raise ValueError('source changed')
    pathlib.Path(q['report']).parent.mkdir(parents=True,exist_ok=True)
    with pathlib.Path(q['report']).open('x',encoding='utf8') as stream: json.dump(report,stream,ensure_ascii=False,indent=2,allow_nan=False)
    return report

if __name__=='__main__': run(json.loads(pathlib.Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf-8-sig')))

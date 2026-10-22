"""Prepare an immutable copy omitting one known read-only Blender RNA write.

This module never imports or executes the authored procedure. Author eligibility
and one-shot local execution are controlled by the app's persisted journal.
"""
import ast
import copy
import hashlib
import json
import pathlib


def sha(data):
    return hashlib.sha256(data).hexdigest()


def omit_readonly_loop_total(raw):
    """Byte-surgical omission with equality of every remaining AST node."""
    try:
        text = raw.decode('utf-8-sig')
        original = ast.parse(text)
    except (UnicodeError, SyntaxError) as error:
        raise RuntimeError('Authored compatibility input is not valid UTF-8 Python') from error
    writes = [node for node in ast.walk(original) if isinstance(node, ast.Attribute)
        and node.attr == 'loop_total' and isinstance(node.ctx, ast.Store)]
    functions = [node for node in original.body if isinstance(node, ast.FunctionDef) and node.name == 'append_geometry']
    if len(writes) != 1 or len(functions) != 1:
        raise RuntimeError('Compatibility requires one exact loop_total assignment in append_geometry')
    matches = [node for node in ast.walk(functions[0]) if isinstance(node, ast.Assign)
        and len(node.targets) == 1 and node.targets[0] is writes[0]
        and isinstance(node.targets[0].value, ast.Name) and node.targets[0].value.id == 'f'
        and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
        and node.value.func.id == 'len' and len(node.value.args) == 1
        and isinstance(node.value.args[0], ast.Name) and node.value.args[0].id == 'face'
        and not node.value.keywords]
    if len(matches) != 1:
        raise RuntimeError('Unsupported loop_total writer; no compatibility transformation applied')
    match = matches[0]
    if match.lineno != match.end_lineno:
        raise RuntimeError('Compatibility assignment must occupy one source line')
    # AST column offsets are UTF-8 byte offsets, not Python character indices.
    bom = b'\xef\xbb\xbf' if raw.startswith(b'\xef\xbb\xbf') else b''
    lines = raw[len(bom):].splitlines(keepends=True)
    line = lines[match.lineno - 1]
    begin, end = match.col_offset, match.end_col_offset
    if line[end:end + 1] == b';':
        end += 1
    removed = line[begin:end]
    lines[match.lineno - 1] = line[:begin] + line[end:]
    transformed = bom + b''.join(lines)
    try:
        after = ast.parse(transformed.decode('utf-8-sig'))
        compile(after, '<compatibility-copy-validation-only>', 'exec')
    except (UnicodeError, SyntaxError) as error:
        raise RuntimeError('Exact omission does not leave valid Python; original kept') from error

    class ExactOmission(ast.NodeTransformer):
        def visit_Assign(self, node):
            return None if (node.lineno, node.col_offset, node.end_lineno, node.end_col_offset) == (
                match.lineno, match.col_offset, match.end_lineno, match.end_col_offset) else node

    expected = ExactOmission().visit(copy.deepcopy(original))
    if ast.dump(expected, include_attributes=False) != ast.dump(after, include_attributes=False):
        raise RuntimeError('Compatibility changed another AST node')
    before_lines = raw[len(bom):].splitlines(keepends=True)
    after_lines = transformed[len(bom):].splitlines(keepends=True)
    if len(before_lines) != len(after_lines) or any(a != b for index, (a, b) in enumerate(zip(before_lines, after_lines)) if index != match.lineno - 1):
        raise RuntimeError('Compatibility changed another source line')
    return transformed, {'schemaVersion': 1, 'operation': 'omit-readonly-MeshPolygon-loop_total',
        'originalSha256': sha(raw), 'transformedSha256': sha(transformed),
        'omittedNode': ast.dump(match, include_attributes=False), 'omittedLine': match.lineno,
        'omittedBytesUtf8': removed.decode('utf-8'), 'astEquivalenceAfterOmission': True,
        'otherSourceLinesExact': True, 'executedProcedure': False}


def prepare_compatibility(q):
    source, target = pathlib.Path(q['authorPath']), pathlib.Path(q['outputScript'])
    report = pathlib.Path(q['report'])
    if source.resolve() == target.resolve() or source.resolve().parent != target.resolve().parent:
        raise RuntimeError('Compatibility copy must be a separate file beside its original procedure')
    if report.resolve() in (source.resolve(), target.resolve()):
        raise RuntimeError('Compatibility receipt cannot overwrite either procedure')
    raw = source.read_bytes()
    if sha(raw) != q['authorSha256']:
        raise RuntimeError('Saved authored procedure hash changed; compatibility stopped')
    transformed, receipt = omit_readonly_loop_total(raw)
    if target.exists():
        if target.read_bytes() != transformed:
            raise RuntimeError('Compatibility output already exists with different bytes')
    else:
        with target.open('xb') as stream:
            stream.write(transformed)
    if source.read_bytes() != raw or target.read_bytes() != transformed:
        raise RuntimeError('Compatibility source or copy changed during preparation')
    receipt.update(authorPath=str(source), outputScript=str(target))
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    return receipt

/** Synthetic triangle solely for binary-validation tests; never a product asset. */
export function buildWorkbenchGlb(seed = 0): Buffer {
  const chunks: Buffer[] = [],
    bufferViews: any[] = [],
    accessors: any[] = [];
  let offset = 0;
  const view = (bytes: Buffer) => {
    const aligned = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
    bytes.copy(aligned);
    chunks.push(aligned);
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
    });
    offset += aligned.length;
    return bufferViews.length - 1;
  };
  const accessor = (
    values: number[],
    width: number,
    type: string,
    componentType = 5126,
  ) => {
    const bytes = Buffer.alloc(
      values.length * (componentType === 5123 ? 2 : 4),
    );
    values.forEach((value, i) =>
      componentType === 5123
        ? bytes.writeUInt16LE(value, i * 2)
        : bytes.writeFloatLE(value, i * 4),
    );
    accessors.push({
      bufferView: view(bytes),
      componentType,
      count: values.length / width,
      type,
    });
    return accessors.length - 1;
  };
  const positions = accessor(
    [0, 0, 0, 1 + seed * 0.001, 0, 0, 0, 1, 0],
    3,
    "VEC3",
  );
  const uvs = accessor([0, 0, 1, 0, 0, 1], 2, "VEC2");
  const joints = accessor(
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    4,
    "VEC4",
    5123,
  );
  const weights = accessor([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4, "VEC4");
  const times = accessor([0, 1, 2], 1, "SCALAR");
  const motion = accessor([0, 0, 0, 0, 0.25, 0, 0, 0, 0], 3, "VEC3");
  const image = view(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const data = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: positions,
              TEXCOORD_0: uvs,
              JOINTS_0: joints,
              WEIGHTS_0: weights,
            },
            material: 0,
          },
        ],
      },
    ],
    nodes: [{ mesh: 0, skin: 0 }, { name: "TestBone" }],
    skins: [{ joints: [1] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: image, mimeType: "image/png" }],
    animations: [
      {
        name: "TestMotion",
        samplers: [{ input: times, output: motion }],
        channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
      },
    ],
    scenes: [{ nodes: [0, 1] }],
    scene: 0,
  };
  const raw = JSON.stringify(data),
    json = Buffer.from(raw.padEnd(Math.ceil(raw.length / 4) * 4, " ")),
    binary = Buffer.concat(chunks);
  const result = Buffer.alloc(20 + json.length + 8 + binary.length);
  result.write("glTF");
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + json.length);
  result.writeUInt32LE(0x004e4942, 24 + json.length);
  binary.copy(result, 28 + json.length);
  return result;
}

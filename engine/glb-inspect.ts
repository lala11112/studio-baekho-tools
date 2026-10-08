/** Structural validation of the exported binary, independent of worker reports. */
export function inspectWorkbenchGlb(
  bytes: Buffer,
  requirements: {
    uv?: boolean;
    texture?: boolean;
    rig?: boolean;
    animation?: boolean;
  } = {},
) {
  if (
    bytes.length < 28 ||
    bytes.toString("ascii", 0, 4) !== "glTF" ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw Error("유효한 GLB 2.0 파일이 아닙니다.");
  const jsonLength = bytes.readUInt32LE(12);
  if (
    bytes.readUInt32LE(16) !== 0x4e4f534a ||
    20 + jsonLength + 8 > bytes.length
  )
    throw Error("GLB JSON 영역이 손상되었습니다.");
  const data = JSON.parse(
    bytes.toString("utf8", 20, 20 + jsonLength).replace(/[\u0000\s]+$/, ""),
  );
  const offset = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(offset);
  if (
    bytes.readUInt32LE(offset + 4) !== 0x004e4942 ||
    offset + 8 + binaryLength > bytes.length ||
    !data.buffers?.[0]?.byteLength ||
    data.buffers[0].uri ||
    data.buffers[0].byteLength > binaryLength
  )
    throw Error("GLB 정점 바이너리 영역이 없습니다.");
  const binary = bytes.subarray(offset + 8, offset + 8 + binaryLength);
  const dimensions: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT4: 16,
  };
  const sizes: Record<number, number> = {
    5120: 1,
    5121: 1,
    5122: 2,
    5123: 2,
    5125: 4,
    5126: 4,
  };
  function view(index: number): Buffer {
    const item = data.bufferViews?.[index];
    if (
      !item ||
      item.buffer !== 0 ||
      !Number.isSafeInteger(item.byteLength) ||
      item.byteLength < 1 ||
      !Number.isSafeInteger(item.byteOffset ?? 0) ||
      (item.byteOffset ?? 0) < 0 ||
      (item.byteOffset ?? 0) + item.byteLength > data.buffers[0].byteLength
    )
      throw Error("GLB bufferView 범위가 올바르지 않습니다.");
    return binary.subarray(
      item.byteOffset ?? 0,
      (item.byteOffset ?? 0) + item.byteLength,
    );
  }
  function accessor(index: number, type?: string): number[][] {
    const item = data.accessors?.[index],
      width = dimensions[item?.type],
      size = sizes[item?.componentType];
    if (
      !item ||
      !width ||
      !size ||
      (type && item.type !== type) ||
      !Number.isSafeInteger(item.count) ||
      item.count < 1 ||
      item.sparse
    )
      throw Error("GLB accessor 데이터가 유효하지 않습니다.");
    const content = view(item.bufferView),
      stride = data.bufferViews[item.bufferView].byteStride ?? width * size,
      start = item.byteOffset ?? 0;
    if (
      !Number.isSafeInteger(stride) ||
      stride < width * size ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start + stride * (item.count - 1) + width * size > content.length
    )
      throw Error("GLB accessor가 실제 바이너리 크기를 벗어납니다.");
    // A bounded binary implies a bounded accessor count; avoid reading invented giant counts.
    return Array.from({ length: item.count }, (_, i) =>
      Array.from({ length: width }, (_, component) => {
        const position = start + stride * i + component * size;
        let value: number;
        switch (item.componentType) {
          case 5120:
            value = content.readInt8(position);
            break;
          case 5121:
            value = content.readUInt8(position);
            break;
          case 5122:
            value = content.readInt16LE(position);
            break;
          case 5123:
            value = content.readUInt16LE(position);
            break;
          case 5125:
            value = content.readUInt32LE(position);
            break;
          default:
            value = content.readFloatLE(position);
        }
        if (item.normalized && item.componentType !== 5126) {
          const divisor =
            item.componentType === 5120
              ? 127
              : item.componentType === 5121
                ? 255
                : item.componentType === 5122
                  ? 32767
                  : item.componentType === 5123
                    ? 65535
                    : 4294967295;
          value = Math.max(-1, value / divisor);
        }
        if (!Number.isFinite(value))
          throw Error("GLB 값에 NaN 또는 무한대가 있습니다.");
        return value;
      }),
    );
  }
  const meshList = data.meshes;
  if (!Array.isArray(meshList) || !meshList.length)
    throw Error("실제 GLB 메시가 없습니다.");
  let primitiveCount = 0;
  for (const mesh of meshList) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length)
      throw Error("실제 GLB primitive가 없습니다.");
    for (const primitive of mesh.primitives) {
      const positions = accessor(primitive.attributes?.POSITION, "VEC3");
      if (positions.length < 3) throw Error("GLB 정점이 부족합니다.");
      if (
        primitive.indices !== undefined &&
        accessor(primitive.indices, "SCALAR").some(
          (value) =>
            !Number.isInteger(value[0]) ||
            value[0] < 0 ||
            value[0] >= positions.length,
        )
      )
        throw Error("GLB 삼각형 인덱스가 정점 범위를 벗어납니다.");
      if (
        (requirements.uv || requirements.texture) &&
        accessor(primitive.attributes?.TEXCOORD_0, "VEC2").length !==
          positions.length
      )
        throw Error("실제 정점과 대응하는 UV가 없습니다.");
      if (requirements.texture) {
        const material = data.materials?.[primitive.material];
        const texture =
          data.textures?.[
            material?.pbrMetallicRoughness?.baseColorTexture?.index
          ];
        const image = data.images?.[texture?.source];
        if (
          !image ||
          image.bufferView === undefined ||
          !/^image\/(png|jpeg|webp)$/.test(image.mimeType)
        )
          throw Error("실제 내장 컬러 텍스처가 없습니다.");
        const pixels = view(image.bufferView);
        const signature =
          pixels
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (pixels[0] === 255 && pixels[1] === 216 && pixels[2] === 255) ||
          (pixels.toString("ascii", 0, 4) === "RIFF" &&
            pixels.toString("ascii", 8, 12) === "WEBP");
        if (!signature)
          throw Error("GLB 텍스처 이미지 바이너리가 손상됐습니다.");
      }
      primitiveCount++;
    }
  }
  if (requirements.rig || requirements.animation) {
    const skinned =
      data.nodes?.filter(
        (node: any) => node.mesh !== undefined && node.skin !== undefined,
      ) ?? [];
    if (!skinned.length)
      throw Error("GLB에 실제 스킨이 연결된 메시가 없습니다.");
    for (const node of skinned) {
      const skin = data.skins?.[node.skin];
      if (
        !skin?.joints?.length ||
        skin.joints.some(
          (index: number) => !Number.isSafeInteger(index) || !data.nodes[index],
        )
      )
        throw Error("GLB 스킨의 실제 본 연결이 없습니다.");
      if (
        skin.inverseBindMatrices !== undefined &&
        accessor(skin.inverseBindMatrices, "MAT4").length !== skin.joints.length
      )
        throw Error("GLB 바인드 행렬 수가 본 수와 다릅니다.");
      const mesh = meshList[node.mesh];
      if (!mesh) throw Error("GLB 스킨 메시 참조가 잘못되었습니다.");
      for (const primitive of mesh.primitives) {
        const count = data.accessors[primitive.attributes.POSITION].count;
        const joints = accessor(primitive.attributes.JOINTS_0, "VEC4"),
          weights = accessor(primitive.attributes.WEIGHTS_0, "VEC4");
        if (joints.length !== count || weights.length !== count)
          throw Error("GLB 웨이트 수가 정점 수와 일치하지 않습니다.");
        if (
          joints.some((values) =>
            values.some(
              (value) =>
                !Number.isInteger(value) ||
                value < 0 ||
                value >= skin.joints.length,
            ),
          ) ||
          weights.some(
            (values) =>
              values.some((value) => value < 0 || value > 1.00001) ||
              Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.01,
          )
        )
          throw Error("GLB 정점의 실제 본 인덱스·웨이트가 올바르지 않습니다.");
      }
    }
  }
  if (requirements.animation) {
    if (!data.animations?.length)
      throw Error("GLB 실제 애니메이션이 없습니다.");
    for (const animation of data.animations) {
      if (!animation.channels?.length || !animation.samplers?.length)
        throw Error("GLB 애니메이션 채널이 없습니다.");
      let varying = false;
      for (const channel of animation.channels) {
        const sampler = animation.samplers[channel.sampler];
        if (
          !sampler ||
          !data.nodes?.[channel.target?.node] ||
          !["translation", "rotation", "scale"].includes(channel.target.path)
        )
          throw Error("GLB 애니메이션 대상·샘플러가 잘못되었습니다.");
        const times = accessor(sampler.input, "SCALAR").map(
          (value) => value[0],
        );
        if (
          times.length < 2 ||
          times.some(
            (time, index) =>
              time < 0 || (index > 0 && time <= times[index - 1]),
          )
        )
          throw Error("GLB 애니메이션 타임라인이 유효하지 않습니다.");
        const values = accessor(
          sampler.output,
          channel.target.path === "rotation" ? "VEC4" : "VEC3",
        );
        const multiplier = sampler.interpolation === "CUBICSPLINE" ? 3 : 1;
        if (values.length !== times.length * multiplier)
          throw Error(
            "GLB 키프레임 수와 애니메이션 데이터가 일치하지 않습니다.",
          );
        const poses =
          multiplier === 3
            ? values.filter((_, index) => index % 3 === 1)
            : values;
        if (
          poses.some((pose) =>
            pose.some(
              (value, index) => Math.abs(value - poses[0][index]) > 0.00001,
            ),
          )
        )
          varying = true;
      }
      if (!varying)
        throw Error("GLB 애니메이션이 정지 포즈 복사로만 구성되어 있습니다.");
    }
  }
  return { data, primitiveCount };
}

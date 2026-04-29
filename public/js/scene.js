import * as THREE from 'three';

// Build a two-storey 40m × 40m house with a ramp connecting the floors.
// Returns:
//   group:     all visual geometry (excluding the painted floor planes,
//              which the painter module owns).
//   colliders: list of { minX, maxX, minZ, maxZ, floor } AABBs in world XZ
//              for movement blocking. `floor` is 0 or 1 indicating which
//              storey the obstacle is on.
//   fadables:  meshes whose materials should fade out when occluding the
//              camera→player ray.
//   ramp:      { xMin, xMax, zMin, zMax, topY } describing the connecting
//              ramp footprint and its peak height.
export function buildHouse(floorSize, floor2Y) {
  const group = new THREE.Group();
  const colliders = [];
  const fadables = [];

  const half = floorSize / 2;
  const wallH1 = floor2Y;            // ground-floor wall height = slab height
  const wallH2 = 4.4;                // upstairs wall height
  const wallT = 0.3;
  const slabT = 0.18;

  // Ramp footprint matches server (RAMP_X_MIN / MAX, RAMP_Z_BOTTOM / TOP).
  const ramp = { xMin: -2.5, xMax: 2.5, zMin: -2, zMax: 8, topY: floor2Y };

  // ---------- Materials ----------
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x8a9bb4, roughness: 0.95, metalness: 0.0,
  });
  const wallMatUp = new THREE.MeshStandardMaterial({
    color: 0xa8b0c2, roughness: 0.95, metalness: 0.0,
  });
  const baseboardMat = new THREE.MeshStandardMaterial({
    color: 0x2b1f15, roughness: 0.6,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xd9cfbf, roughness: 0.7,
  });
  const ceilingMat = new THREE.MeshStandardMaterial({
    color: 0xfafafa, roughness: 0.95, side: THREE.DoubleSide,
  });
  const slabMat = new THREE.MeshStandardMaterial({
    color: 0x3a2614, roughness: 0.85,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x8b5a2b, roughness: 0.6,
  });
  const darkWoodMat = new THREE.MeshStandardMaterial({
    color: 0x4a2f1a, roughness: 0.55,
  });
  const fabricMat = new THREE.MeshStandardMaterial({ color: 0x4a5d7a, roughness: 0.95 });
  const fabricMatWarm = new THREE.MeshStandardMaterial({ color: 0xb86b4b, roughness: 0.95 });
  const fabricMatGreen = new THREE.MeshStandardMaterial({ color: 0x4a6b4f, roughness: 0.95 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.35, metalness: 0.7 });
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xc8c4be, roughness: 0.4 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xaee6ff, transparent: true, opacity: 0.18,
    roughness: 0.05, transmission: 0.9, thickness: 0.05,
  });
  const plantMat = new THREE.MeshStandardMaterial({ color: 0x2f7f3f, roughness: 0.85 });
  const potMat = new THREE.MeshStandardMaterial({ color: 0xb37050, roughness: 0.7 });

  // ---------- Helpers ----------
  function addBox(w, h, d, mat, x, y, z, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat.clone());
    m.position.set(x, y, z);
    m.castShadow = opts.castShadow ?? true;
    m.receiveShadow = opts.receiveShadow ?? true;
    m.userData.fadable = true;
    fadables.push(m);
    group.add(m);
    if (opts.collide) {
      colliders.push({
        minX: x - w / 2, maxX: x + w / 2,
        minZ: z - d / 2, maxZ: z + d / 2,
        floor: opts.floor ?? 0,
      });
    }
    return m;
  }

  // Add wall segment along given side. Side: 'N', 'S', 'E', 'W'.
  // Position along axis is `along`, world Y is `y`, length is `lenAlong`,
  // height is `h`, on storey `floor` (0 or 1).
  function addWallSegment(side, along, y, lenAlong, h, floor, collide, mat) {
    const off = (side === 'N') ? -half - wallT/2
              : (side === 'S') ?  half + wallT/2
              : (side === 'E') ?  half + wallT/2
              : -half - wallT/2;
    const axisX = side === 'N' || side === 'S';
    const x = axisX ? along : off;
    const z = axisX ? off   : along;
    const w = axisX ? lenAlong : wallT;
    const d = axisX ? wallT   : lenAlong;
    addBox(w, h, d, mat, x, y, z, { collide, floor });
  }

  function buildOuterWall(side, baseY, wallH, mat, floor) {
    const len = floorSize;
    const winH = 1.8;
    const winY = 1.1 + baseY;
    const winLen = floorSize * 0.45;
    const sideLen = (len - winLen) / 2;

    addWallSegment(side, 0, baseY + (winY - baseY) / 2, winLen, winY - baseY, floor, true, mat);
    const upperY = winY + winH;
    const upperH = (baseY + wallH) - upperY;
    if (upperH > 0.05) {
      addWallSegment(side, 0, upperY + upperH / 2, winLen, upperH, floor, false, mat);
    }
    addWallSegment(side, -(winLen/2 + sideLen/2), baseY + wallH/2, sideLen, wallH, floor, true, mat);
    addWallSegment(side, +(winLen/2 + sideLen/2), baseY + wallH/2, sideLen, wallH, floor, true, mat);

    // Window glass
    const axisX = side === 'N' || side === 'S';
    const off = (side === 'N') ? -half - wallT/2
              : (side === 'S') ?  half + wallT/2
              : (side === 'E') ?  half + wallT/2
              : -half - wallT/2;
    const glassThk = 0.04;
    const glassGeo = new THREE.BoxGeometry(
      axisX ? winLen : glassThk,
      winH,
      axisX ? glassThk : winLen,
    );
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.set(axisX ? 0 : off, winY + winH / 2, axisX ? off : 0);
    group.add(glass);

    // Window trim (top + bottom thin bars)
    const trimW = axisX ? winLen + 0.1 : 0.18;
    const trimD = axisX ? 0.18 : winLen + 0.1;
    addBox(trimW, 0.08, trimD, trimMat, axisX ? 0 : off, winY, axisX ? off : 0);
    addBox(trimW, 0.08, trimD, trimMat, axisX ? 0 : off, winY + winH, axisX ? off : 0);
  }

  // ---------- Outer walls (both floors) ----------
  for (const side of ['N','S','E','W']) {
    buildOuterWall(side, 0,         wallH1, wallMat,   0);
    buildOuterWall(side, floor2Y,   wallH2, wallMatUp, 1);
  }

  // ---------- Slab between floors ----------
  // The slab is the upstairs floor (mechanically). The painter places the
  // upstairs paint canvas just above this. We cut a hole for the ramp.
  // Implement as 4 strips around a rectangular hole.
  const HX1 = ramp.xMin, HX2 = ramp.xMax;
  const HZ1 = ramp.zMin, HZ2 = ramp.zMax;
  const slabY = floor2Y - slabT / 2;

  // Strip south of the hole
  if (HZ2 < half) {
    const z = (HZ2 + half) / 2;
    const d = half - HZ2;
    addBox(floorSize, slabT, d, slabMat, 0, slabY, z, { collide: false });
  }
  // Strip north of the hole
  if (HZ1 > -half) {
    const z = (-half + HZ1) / 2;
    const d = HZ1 - (-half);
    addBox(floorSize, slabT, d, slabMat, 0, slabY, z, { collide: false });
  }
  // Strip east of the hole (between hole z range)
  if (HX2 < half) {
    const x = (HX2 + half) / 2;
    const w = half - HX2;
    addBox(w, slabT, HZ2 - HZ1, slabMat, x, slabY, (HZ1 + HZ2) / 2, { collide: false });
  }
  // Strip west of the hole
  if (HX1 > -half) {
    const x = (-half + HX1) / 2;
    const w = HX1 - (-half);
    addBox(w, slabT, HZ2 - HZ1, slabMat, x, slabY, (HZ1 + HZ2) / 2, { collide: false });
  }

  // Soft railing around the upstairs hole so players don't fall in.
  // IMPORTANT: no rail on the +Z (HZ2) side — that's where the ramp emerges
  // onto the upstairs slab, putting a rail there would trap anyone climbing.
  const railH = 1.1;
  const railT = 0.08;
  const railMat = darkWoodMat;
  // North edge of hole (-Z): blocks upstairs walking south into hole.
  addBox(HX2 - HX1, railH, railT, railMat,
    (HX1 + HX2) / 2, floor2Y + railH / 2, HZ1,
    { collide: true, floor: 1 });
  // East edge of hole (+X)
  addBox(railT, railH, HZ2 - HZ1, railMat,
    HX2, floor2Y + railH / 2, (HZ1 + HZ2) / 2,
    { collide: true, floor: 1 });
  // West edge of hole (-X)
  addBox(railT, railH, HZ2 - HZ1, railMat,
    HX1, floor2Y + railH / 2, (HZ1 + HZ2) / 2,
    { collide: true, floor: 1 });

  // Ground-floor side walls flanking the ramp, so the only way ONTO the ramp
  // from floor 0 is the south entrance (z < HZ1). Without these, a player
  // could step laterally onto the ramp and be teleported up.
  const rampSideWallH = floor2Y;
  addBox(railT, rampSideWallH, HZ2 - HZ1, baseboardMat,
    HX1, rampSideWallH / 2, (HZ1 + HZ2) / 2,
    { collide: true, floor: 0 });
  addBox(railT, rampSideWallH, HZ2 - HZ1, baseboardMat,
    HX2, rampSideWallH / 2, (HZ1 + HZ2) / 2,
    { collide: true, floor: 0 });

  // ---------- Ramp ----------
  // A tilted box from (mid, 0) at zMin to (mid, floor2Y) at zMax. Width matches
  // ramp footprint. We compute angle and length.
  const rampXC = (HX1 + HX2) / 2;
  const rampZC = (HZ1 + HZ2) / 2;
  const rampLen = Math.sqrt(RAMP_LEN_SQ(HZ2 - HZ1, floor2Y));
  const rampThk = 0.18;
  const rampWidth = HX2 - HX1;
  const rampGeo = new THREE.BoxGeometry(rampWidth, rampThk, rampLen);
  const rampMesh = new THREE.Mesh(rampGeo, woodMat.clone());
  rampMesh.position.set(rampXC, floor2Y / 2, rampZC);
  rampMesh.rotation.x = -Math.atan2(floor2Y, HZ2 - HZ1);
  rampMesh.castShadow = true;
  rampMesh.receiveShadow = true;
  rampMesh.userData.fadable = true;
  fadables.push(rampMesh);
  group.add(rampMesh);

  // Ramp side rails
  const sideRailH = 0.9;
  for (const xs of [HX1, HX2]) {
    const railGeo = new THREE.BoxGeometry(0.06, sideRailH, rampLen);
    const rail = new THREE.Mesh(railGeo, darkWoodMat.clone());
    rail.position.set(xs, floor2Y / 2 + sideRailH / 2, rampZC);
    rail.rotation.x = -Math.atan2(floor2Y, HZ2 - HZ1);
    rail.castShadow = true;
    rail.userData.fadable = true;
    fadables.push(rail);
    group.add(rail);
  }

  // ---------- Ceiling ----------
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize + wallT, floorSize + wallT),
    ceilingMat,
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = floor2Y + wallH2;
  ceiling.receiveShadow = true;
  group.add(ceiling);

  // ---------- Wood-grain plank lines (both floors) ----------
  function addPlanks(y, color = 0x3a2614, alphaW = floorSize, alphaD = floorSize) {
    for (let i = -alphaD / 2 + 1.6; i < alphaD / 2; i += 1.6) {
      const plank = new THREE.Mesh(
        new THREE.PlaneGeometry(alphaW, 0.04),
        new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
      );
      plank.rotation.x = -Math.PI / 2;
      plank.position.set(0, y + 0.001, i);
      group.add(plank);
    }
  }
  addPlanks(0);                  // ground floor — under painter floor 0
  addPlanks(floor2Y);            // upstairs — under painter floor 1

  // ---------- Baseboards on both floors ----------
  for (const baseY of [0, floor2Y]) {
    const baseH = 0.18;
    for (const [x, z, w, d] of [
      [0, -half + 0.04, floorSize, 0.08],
      [0,  half - 0.04, floorSize, 0.08],
      [-half + 0.04, 0, 0.08, floorSize],
      [ half - 0.04, 0, 0.08, floorSize],
    ]) {
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(w, baseH, d),
        baseboardMat.clone(),
      );
      base.position.set(x, baseY + baseH / 2, z);
      group.add(base);
    }
  }

  // ---------- Interior dividers (ground floor) ----------
  // Kitchen pocket SW
  addBox(0.25, wallH1 * 0.7, 10, wallMat, -half + 10, wallH1 * 0.35, half - 5, { collide: true, floor: 0 });
  // Bedroom-ish pocket NE
  addBox(9, wallH1 * 0.7, 0.25, wallMat, half - 4.5, wallH1 * 0.35, -half + 9, { collide: true, floor: 0 });
  addBox(0.25, wallH1 * 0.7, 5, wallMat, half - 9, wallH1 * 0.35, -half + 6.5, { collide: true, floor: 0 });

  // ---------- Interior dividers (upstairs) ----------
  // A study divider
  addBox(0.25, wallH2 * 0.8, 12, wallMatUp, -half + 12, floor2Y + wallH2 * 0.4, half - 6, { collide: true, floor: 1 });
  // A bedroom suite divider
  addBox(11, wallH2 * 0.8, 0.25, wallMatUp, half - 5.5, floor2Y + wallH2 * 0.4, -half + 12, { collide: true, floor: 1 });

  // ===================== GROUND FLOOR FURNITURE =====================
  // Living room sofa (L) around (8, 0, 11)
  const sofaY = 0.45;
  addBox(5.4, 0.9, 1.4, fabricMat, 8, sofaY, 12, { collide: true, floor: 0 });
  addBox(1.4, 0.9, 4.4, fabricMat, 10, sofaY, 9.7, { collide: true, floor: 0 });
  addBox(5.4, 1.4, 0.22, fabricMat, 8, 1.1, 12.6, { collide: true, floor: 0 });
  addBox(0.22, 1.4, 4.4, fabricMat, 10.6, 1.1, 9.7, { collide: true, floor: 0 });

  // Coffee table
  addBox(2.4, 0.5, 1.4, darkWoodMat, 7.5, 0.25, 9.5, { collide: true, floor: 0 });

  // TV unit + TV
  addBox(4.0, 0.5, 0.6, darkWoodMat, 4, 0.25, half - 0.7, { collide: true, floor: 0 });
  addBox(3.4, 1.6, 0.08, metalMat, 4, 1.7, half - 0.95);

  // Dining table at (-8, 0, 2)
  addBox(3.0, 0.05, 1.6, woodMat, -8, 0.78, 2);
  for (const [tx, tz] of [[-9.4, 1.1],[-6.6, 1.1],[-9.4, 2.9],[-6.6, 2.9]]) {
    addBox(0.1, 0.78, 0.1, darkWoodMat, tx, 0.39, tz);
  }
  for (const [cx, cz] of [[-8, 0.4],[-8, 3.6],[-9.8, 2],[-6.2, 2]]) {
    addBox(0.6, 0.5, 0.6, woodMat, cx, 0.25, cz, { collide: true, floor: 0 });
    addBox(0.6, 0.7, 0.1, woodMat, cx, 0.75, cz - 0.25, {});
  }

  // Kitchen counter L-shape (along the SW divider)
  addBox(1.0, 0.95, 9.0, stoneMat, -half + 10 - 0.6, 0.475, half - 5, { collide: true, floor: 0 });
  addBox(8.0, 0.95, 1.0, stoneMat, -half + 6, 0.475, -half + 0.6 + half - 9 - 0.5, { collide: false, floor: 0 }); // intentionally suppressed-floor; visual only
  // Kitchen island (free-standing)
  addBox(3.0, 0.95, 1.4, stoneMat, -10, 0.475, 11, { collide: true, floor: 0 });
  addBox(3.0, 0.06, 1.5, darkWoodMat, -10, 0.99, 11);
  for (const sx of [-11, -9]) {
    addBox(0.4, 0.7, 0.4, darkWoodMat, sx, 0.35, 12.6, { collide: true, floor: 0 });
  }

  // Bookshelf (wall on west, ground floor)
  addBox(0.5, 2.6, 4.0, darkWoodMat, -half + 0.6, 1.3, -3, { collide: true, floor: 0 });
  // a few colored books as horizontal stripes
  for (let i = 0; i < 4; i++) {
    const colors = [0xb84a2c, 0x2c6bb8, 0xb89a2c, 0x4ab83c];
    addBox(0.4, 0.32, 3.6, new THREE.MeshStandardMaterial({ color: colors[i], roughness: 0.9 }),
      -half + 0.6, 0.4 + i * 0.55, -3);
  }

  // Plants on ground floor
  for (const [px, pz] of [[half - 1.2, -1], [-half + 1.2, 13], [half - 1.2, 8], [3, -10]]) {
    addBox(0.7, 0.45, 0.7, potMat, px, 0.225, pz, { collide: true, floor: 0 });
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 14, 12),
      plantMat.clone(),
    );
    leaf.position.set(px, 1.1, pz); leaf.scale.y = 1.5; leaf.castShadow = true;
    group.add(leaf);
  }

  // Pendant lights (ground floor, over living room and dining)
  for (const [lx, lz] of [[-8, 2], [8, 11]]) {
    addPendantLight(lx, lz, wallH1, group);
  }

  // ===================== UPSTAIRS FURNITURE =====================
  const fy = floor2Y;
  // Bed (north wall area)
  addBox(3.0, 0.4, 4.4, woodMat, half - 5.5, fy + 0.2, -half + 6.5, { collide: true, floor: 1 });
  addBox(3.0, 0.5, 4.0, fabricMatWarm, half - 5.5, fy + 0.55, -half + 6.7);
  addBox(3.0, 1.2, 0.22, woodMat, half - 5.5, fy + 0.85, -half + 4.4);
  addBox(0.8, 0.6, 0.8, darkWoodMat, half - 8, fy + 0.3, -half + 4.6, { collide: true, floor: 1 });
  addBox(0.8, 0.6, 0.8, darkWoodMat, half - 3, fy + 0.3, -half + 4.6, { collide: true, floor: 1 });

  // Wardrobe
  addBox(3.5, 2.6, 0.8, darkWoodMat, half - 2.5, fy + 1.3, -half + 13, { collide: true, floor: 1 });

  // Study desk (south of upstairs)
  addBox(2.4, 0.05, 1.0, darkWoodMat, -half + 6, fy + 0.78, half - 1.5);
  for (const [tx, tz] of [[-half+5, half-2],[-half+7, half-2],[-half+5, half-1],[-half+7, half-1]]) {
    addBox(0.08, 0.78, 0.08, darkWoodMat, tx, fy + 0.39, tz);
  }
  // Office chair
  addBox(0.6, 0.5, 0.6, fabricMat, -half + 6, fy + 0.25, half - 2.6, { collide: true, floor: 1 });
  addBox(0.6, 0.7, 0.1, fabricMat, -half + 6, fy + 0.75, half - 2.85);

  // Reading sofa upstairs
  addBox(3.0, 0.85, 1.4, fabricMatGreen, -half + 5, fy + 0.425, -2, { collide: true, floor: 1 });
  addBox(3.0, 1.3, 0.22, fabricMatGreen, -half + 5, fy + 1.05, -2.6, { collide: true, floor: 1 });

  // Plants upstairs
  for (const [px, pz] of [[half - 1.2, 5], [-half + 1.2, -8]]) {
    addBox(0.7, 0.45, 0.7, potMat, px, fy + 0.225, pz, { collide: true, floor: 1 });
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 14, 12),
      plantMat.clone(),
    );
    leaf.position.set(px, fy + 1.1, pz); leaf.scale.y = 1.5;
    group.add(leaf);
  }

  // Pendant lights upstairs
  addPendantLight(-half + 6, half - 2, fy + wallH2, group);
  addPendantLight(half - 5.5, -half + 6.5, fy + wallH2, group);

  return { group, colliders, fadables, ramp };
}

function RAMP_LEN_SQ(zSpan, ySpan) { return zSpan * zSpan + ySpan * ySpan; }

function addPendantLight(lx, lz, ceilingY, group) {
  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 1.4),
    new THREE.MeshStandardMaterial({ color: 0x222222 }),
  );
  cord.position.set(lx, ceilingY - 0.7, lz);
  group.add(cord);
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 0.5, 16, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x222222, side: THREE.DoubleSide }),
  );
  shade.position.set(lx, ceilingY - 1.55, lz);
  group.add(shade);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 10),
    new THREE.MeshStandardMaterial({
      color: 0xfff2c8, emissive: 0xffd28b, emissiveIntensity: 1.6,
    }),
  );
  bulb.position.set(lx, ceilingY - 1.65, lz);
  group.add(bulb);
  const point = new THREE.PointLight(0xffd28b, 1.4, 14, 1.4);
  point.position.set(lx, ceilingY - 1.7, lz);
  group.add(point);
}

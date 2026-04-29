import * as THREE from 'three';

// Build a modern open-plan house interior with flat playable floor.
// Returns { group, colliders, floorMesh } where:
//   - group: THREE.Group containing the entire house (excluding the painted floor)
//   - colliders: list of {minX, maxX, minZ, maxZ} AABBs in world space (XZ plane)
//   - floorMesh: kept null here; the painted floor is built by the painter module
export function buildHouse(floorSize) {
  const group = new THREE.Group();
  const colliders = [];

  const half = floorSize / 2;
  const wallH = 4.2;
  const wallT = 0.25;

  // ---------- Materials ----------
  // Walls are a cool blue-gray so they read clearly against the warm wood floor.
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x8a9bb4, roughness: 0.95, metalness: 0.0,
  });
  // Accent panel for one feature wall to add depth.
  const wallAccentMat = new THREE.MeshStandardMaterial({
    color: 0x4d5a7a, roughness: 0.95,
  });
  // Dark baseboard so the wall-floor junction has a clean line at any camera angle.
  const baseboardMat = new THREE.MeshStandardMaterial({
    color: 0x2b1f15, roughness: 0.6,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xd9cfbf, roughness: 0.7,
  });
  const ceilingMat = new THREE.MeshStandardMaterial({
    color: 0xfafafa, roughness: 0.95, side: THREE.DoubleSide,
  });
  const woodMat = new THREE.MeshStandardMaterial({
    color: 0x8b5a2b, roughness: 0.6,
  });
  const darkWoodMat = new THREE.MeshStandardMaterial({
    color: 0x4a2f1a, roughness: 0.55,
  });
  const fabricMat = new THREE.MeshStandardMaterial({
    color: 0x4a5d7a, roughness: 0.95,
  });
  const fabricMatWarm = new THREE.MeshStandardMaterial({
    color: 0xb86b4b, roughness: 0.95,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a3a, roughness: 0.35, metalness: 0.7,
  });
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0xc8c4be, roughness: 0.4,
  });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xaee6ff, transparent: true, opacity: 0.18,
    roughness: 0.05, transmission: 0.9, thickness: 0.05,
  });
  const plantMat = new THREE.MeshStandardMaterial({
    color: 0x2f7f3f, roughness: 0.85,
  });
  const potMat = new THREE.MeshStandardMaterial({
    color: 0xb37050, roughness: 0.7,
  });

  // ---------- Helpers ----------
  function addBox(w, h, d, mat, x, y, z, opts = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = opts.castShadow ?? true;
    m.receiveShadow = opts.receiveShadow ?? true;
    group.add(m);
    if (opts.collide) {
      colliders.push({
        minX: x - w / 2, maxX: x + w / 2,
        minZ: z - d / 2, maxZ: z + d / 2,
      });
    }
    return m;
  }

  // ---------- Outer walls (with window cutouts done by stacking segments) ----------
  // North wall (z = -half), with a wide window
  buildOuterWall('N');
  buildOuterWall('S');
  buildOuterWall('E');
  buildOuterWall('W');

  function buildOuterWall(side) {
    // Build a wall as: lower section + upper section + side pillars (window in the middle)
    // Each side's wall is at the given edge; main axis runs along the wall.
    const len = floorSize;
    const winH = 1.8;
    const winY = 1.2;
    const winLen = floorSize * 0.5;
    const sideLen = (len - winLen) / 2;

    let centerOffset, axis, normal;
    if (side === 'N') { centerOffset = [0, -half - wallT/2]; axis = 'x'; }
    else if (side === 'S') { centerOffset = [0, half + wallT/2]; axis = 'x'; }
    else if (side === 'E') { centerOffset = [half + wallT/2, 0]; axis = 'z'; }
    else { centerOffset = [-half - wallT/2, 0]; axis = 'z'; }

    // Lower segment under the window
    addWallSegment(side, axis, centerOffset, 0, winY/2, winLen, winY, true);
    // Upper segment above the window
    addWallSegment(side, axis, centerOffset, 0, winY + winH + (wallH - winY - winH)/2, winLen, wallH - winY - winH, false);
    // Two side segments
    addWallSegment(side, axis, centerOffset, -(winLen/2 + sideLen/2), wallH/2, sideLen, wallH, true);
    addWallSegment(side, axis, centerOffset, +(winLen/2 + sideLen/2), wallH/2, sideLen, wallH, true);

    // Glass pane in the window
    const glassThickness = 0.05;
    const glassGeo = new THREE.BoxGeometry(
      axis === 'x' ? winLen : glassThickness,
      winH,
      axis === 'x' ? glassThickness : winLen,
    );
    const glass = new THREE.Mesh(glassGeo, glassMat);
    glass.position.set(centerOffset[0], winY + winH/2, centerOffset[1]);
    group.add(glass);

    // Window trim (top + bottom thin bars)
    const trimW = axis === 'x' ? winLen + 0.1 : 0.15;
    const trimD = axis === 'x' ? 0.15 : winLen + 0.1;
    addBox(trimW, 0.08, trimD, trimMat, centerOffset[0], winY, centerOffset[1]);
    addBox(trimW, 0.08, trimD, trimMat, centerOffset[0], winY + winH, centerOffset[1]);
  }

  function addWallSegment(side, axis, center, along, y, lenAlong, h, collide) {
    let x, z, w, d;
    if (axis === 'x') {
      x = center[0] + along; z = center[1];
      w = lenAlong; d = wallT;
    } else {
      x = center[0]; z = center[1] + along;
      w = wallT; d = lenAlong;
    }
    addBox(w, h, d, wallMat, x, y, z, { collide });
  }

  // Outer collider wraps the entire outside (so we don't escape)
  // The window panes are non-collidable but the side pillars + lower/upper segments are.

  // ---------- Ceiling ----------
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize + wallT * 2, floorSize + wallT * 2),
    ceilingMat,
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = wallH;
  ceiling.receiveShadow = true;
  group.add(ceiling);

  // Floor base under the painted floor (a slightly darker wooden base so untouched areas look natural)
  // The painter floor sits at y=0.01. This base sits at y=-0.005 and is darker.
  const floorBase = new THREE.Mesh(
    new THREE.PlaneGeometry(floorSize, floorSize),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.85 }),
  );
  floorBase.rotation.x = -Math.PI / 2;
  floorBase.position.y = -0.005;
  floorBase.receiveShadow = true;
  group.add(floorBase);

  // Plank lines on the floor: thin dark strips every 1.5m along z, so untouched
  // floor reads as wood instead of a flat slab from above.
  for (let i = -floorSize / 2 + 1.5; i < floorSize / 2; i += 1.5) {
    const plank = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x3a2614, roughness: 0.8 }),
    );
    plank.rotation.x = -Math.PI / 2;
    plank.position.set(0, 0.0, i);
    group.add(plank);
  }

  // Baseboards along all four outer walls — a short dark band that defines the
  // floor edge at every camera angle.
  const baseH = 0.18;
  const baseT = 0.06;
  const halfB = floorSize / 2;
  for (const [x, z, w, d] of [
    [0, -halfB + baseT / 2, floorSize, baseT],
    [0, halfB - baseT / 2, floorSize, baseT],
    [-halfB + baseT / 2, 0, baseT, floorSize],
    [halfB - baseT / 2, 0, baseT, floorSize],
  ]) {
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(w, baseH, d),
      baseboardMat,
    );
    base.position.set(x, baseH / 2, z);
    group.add(base);
  }

  // ---------- Interior dividers (suggest rooms but stay open) ----------
  // A short divider creating a "kitchen" pocket in the SW corner.
  addBox(0.2, wallH * 0.7, 8, wallMat, -half + 8, wallH * 0.35, half - 4, { collide: true });
  // Another divider creating a "bedroom" pocket in NE.
  addBox(7, wallH * 0.7, 0.2, wallMat, half - 3.5, wallH * 0.35, -half + 7, { collide: true });
  addBox(0.2, wallH * 0.7, 4, wallMat, half - 7, wallH * 0.35, -half + 5, { collide: true });

  // ---------- Furniture ----------
  // Living room sofa (L-shape) around (5, 0, 5)
  const sofaY = 0.45;
  addBox(4.2, 0.9, 1.2, fabricMat, 5, sofaY, 7.5, { collide: true });
  addBox(1.2, 0.9, 3.6, fabricMat, 6.5, sofaY, 5.7, { collide: true });
  // Sofa back
  addBox(4.2, 1.4, 0.2, fabricMat, 5, 1.1, 8.0, { collide: true });
  addBox(0.2, 1.4, 3.6, fabricMat, 7.0, 1.1, 5.7, { collide: true });

  // Coffee table
  addBox(2.0, 0.5, 1.2, darkWoodMat, 4.5, 0.25, 5.5, { collide: true });

  // TV unit
  addBox(3.2, 0.5, 0.5, darkWoodMat, 1.0, 0.25, 9.4, { collide: true });
  // TV
  addBox(2.6, 1.4, 0.08, metalMat, 1.0, 1.5, 9.5, { collide: false });

  // Dining table (center)
  addBox(2.6, 0.05, 1.4, woodMat, -3, 0.78, 1, { collide: true });
  // Table legs
  for (const [tx, tz] of [[-3-1.2, 1-0.6],[-3+1.2,1-0.6],[-3-1.2,1+0.6],[-3+1.2,1+0.6]]) {
    addBox(0.1, 0.78, 0.1, darkWoodMat, tx, 0.39, tz, { collide: false });
  }
  // Dining chairs (4)
  const chairs = [[-3, 1, -1.2, 0],[-3, 1, 3.2, Math.PI],[-5, 1, 1, Math.PI/2],[-1, 1, 1, -Math.PI/2]];
  for (const [cx, , cz] of chairs) {
    addBox(0.6, 0.5, 0.6, woodMat, cx, 0.25, cz, { collide: true });
    addBox(0.6, 0.6, 0.1, woodMat, cx, 0.7, cz - 0.25, { collide: false });
  }

  // Kitchen counter (along the SW divider) — keep it OFF the floor so painters can run beside it
  addBox(0.9, 0.95, 7.0, stoneMat, -half + 8 - 0.55, 0.475, half - 4, { collide: true });
  // Kitchen island
  addBox(2.6, 0.95, 1.2, stoneMat, -8, 0.475, 8, { collide: true });
  addBox(2.6, 0.06, 1.3, darkWoodMat, -8, 0.99, 8, { collide: false });
  // Bar stools
  for (const sx of [-9, -7]) {
    addBox(0.4, 0.7, 0.4, darkWoodMat, sx, 0.35, 9.3, { collide: true });
  }

  // Bedroom (NE corner)
  // Bed
  addBox(2.4, 0.4, 3.4, woodMat, half - 3.5, 0.2, -half + 4, { collide: true });
  addBox(2.4, 0.5, 3.0, fabricMatWarm, half - 3.5, 0.55, -half + 4.2, { collide: false });
  addBox(2.4, 1.0, 0.2, woodMat, half - 3.5, 0.7, -half + 2.4, { collide: false }); // headboard
  // Nightstands
  addBox(0.7, 0.55, 0.7, darkWoodMat, half - 5.2, 0.275, -half + 2.5, { collide: true });
  addBox(0.7, 0.55, 0.7, darkWoodMat, half - 1.8, 0.275, -half + 2.5, { collide: true });
  // Wardrobe
  addBox(2.5, 2.4, 0.7, darkWoodMat, half - 1.5, 1.2, -half + 9, { collide: true });

  // Bookshelf (between TV and dining)
  addBox(0.5, 2.6, 3.0, darkWoodMat, -half + 0.6, 1.3, -2, { collide: true });

  // Plants in pots scattered
  for (const [px, pz] of [[half - 0.8, 0.5], [-half + 1.2, 9], [-half + 1.2, -8], [3, -7]]) {
    addBox(0.6, 0.4, 0.6, potMat, px, 0.2, pz, { collide: true });
    const leaf = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      plantMat,
    );
    leaf.position.set(px, 0.95, pz);
    leaf.scale.y = 1.4;
    leaf.castShadow = true;
    group.add(leaf);
  }

  // Pendant lights
  for (const lx of [-3, 5]) {
    const cord = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.01, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x222222 }),
    );
    cord.position.set(lx, wallH - 0.7, 1);
    group.add(cord);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.4, 16, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x222222, side: THREE.DoubleSide }),
    );
    shade.position.set(lx, wallH - 1.5, 1);
    group.add(shade);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 12, 10),
      new THREE.MeshStandardMaterial({
        color: 0xfff2c8, emissive: 0xffd28b, emissiveIntensity: 1.5,
      }),
    );
    bulb.position.set(lx, wallH - 1.55, 1);
    group.add(bulb);

    const point = new THREE.PointLight(0xffd28b, 1.2, 12, 1.4);
    point.position.set(lx, wallH - 1.6, 1);
    point.castShadow = false;
    group.add(point);
  }

  return { group, colliders };
}

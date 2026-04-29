import * as THREE from 'three';

// Floor painter: a CanvasTexture mapped onto the floor mesh.
// Paint stamps are circular soft-edge brushes. The pixel grid is also used
// for owner-color sampling so that we can enforce the "only walk on your color"
// rule (we keep a parallel Uint8Array of owner ids).
export class Painter {
  constructor({ floorSize, resolution = 1024, gridResolution = 256 }) {
    this.floorSize = floorSize;
    this.resolution = resolution;
    this.gridResolution = gridResolution;

    // Visible canvas (high res for nice paint look)
    this.canvas = document.createElement('canvas');
    this.canvas.width = resolution;
    this.canvas.height = resolution;
    this.ctx = this.canvas.getContext('2d');
    this.clearCanvas();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;

    // Logical owner grid (low res), maps cell -> player id (0 = empty)
    this.grid = new Uint8Array(gridResolution * gridResolution);

    // Build floor mesh
    const geo = new THREE.PlaneGeometry(floorSize, floorSize, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: this.texture,
      roughness: 0.65,
      metalness: 0.0,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.01;
    this.mesh.receiveShadow = true;
  }

  clearCanvas() {
    // Transparent floor: untouched cells show the wood base under it
    this.ctx.clearRect(0, 0, this.resolution, this.resolution);
  }

  reset() {
    this.clearCanvas();
    this.grid.fill(0);
    this.texture.needsUpdate = true;
  }

  // World coords (x in [-S/2, S/2], z in [-S/2, S/2]) -> canvas px
  worldToPx(x, z) {
    const u = (x + this.floorSize / 2) / this.floorSize;
    const v = (z + this.floorSize / 2) / this.floorSize;
    return { px: u * this.resolution, py: v * this.resolution };
  }

  worldToCell(x, z) {
    const u = (x + this.floorSize / 2) / this.floorSize;
    const v = (z + this.floorSize / 2) / this.floorSize;
    return {
      cx: Math.floor(u * this.gridResolution),
      cz: Math.floor(v * this.gridResolution),
    };
  }

  // Paint a soft-edge circle and stamp owner id into grid.
  paint(x, z, radiusMeters, color, ownerId) {
    const { px, py } = this.worldToPx(x, z);
    const rPx = (radiusMeters / this.floorSize) * this.resolution;

    const grad = this.ctx.createRadialGradient(px, py, 0, px, py, rPx);
    grad.addColorStop(0, this.colorWithAlpha(color, 1.0));
    grad.addColorStop(0.7, this.colorWithAlpha(color, 0.9));
    grad.addColorStop(1, this.colorWithAlpha(color, 0));

    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = grad;
    this.ctx.beginPath();
    this.ctx.arc(px, py, rPx, 0, Math.PI * 2);
    this.ctx.fill();

    // Stamp grid
    const cellsPerMeter = this.gridResolution / this.floorSize;
    const rc = radiusMeters * cellsPerMeter * 0.85; // slight inset so the
    // visual edge is softer than the playable edge
    const { cx, cz } = this.worldToCell(x, z);
    const r2 = rc * rc;
    const minX = Math.max(0, Math.floor(cx - rc));
    const maxX = Math.min(this.gridResolution - 1, Math.ceil(cx + rc));
    const minZ = Math.max(0, Math.floor(cz - rc));
    const maxZ = Math.min(this.gridResolution - 1, Math.ceil(cz + rc));
    for (let zi = minZ; zi <= maxZ; zi++) {
      for (let xi = minX; xi <= maxX; xi++) {
        const dx = xi - cx;
        const dz = zi - cz;
        if (dx * dx + dz * dz <= r2) {
          this.grid[zi * this.gridResolution + xi] = ownerId;
        }
      }
    }

    this.texture.needsUpdate = true;
  }

  // Returns owner id at world (x, z), or 0
  ownerAt(x, z) {
    const { cx, cz } = this.worldToCell(x, z);
    if (cx < 0 || cx >= this.gridResolution || cz < 0 || cz >= this.gridResolution) return 0;
    return this.grid[cz * this.gridResolution + cx];
  }

  colorWithAlpha(hex, a) {
    // Accepts #rrggbb
    const v = parseInt(hex.slice(1), 16);
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
}

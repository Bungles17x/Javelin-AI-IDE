/**
 * Complete starter projects the agent can generate in one tool call.
 *
 * A small local model cannot write 600 coherent lines before it loses the thread,
 * but it can choose a template and then make targeted edits. These templates are
 * real, runnable projects (no build step, no dependencies except a CDN import for
 * three.js) so "make me a game" starts from something that already works.
 */

const GAME = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sky Dodge</title>
<style>
  html, body { height: 100%; margin: 0; background: #0b1220; color: #e8eef8; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; }
  canvas { display: block; border-radius: 12px; box-shadow: 0 20px 60px #0008; touch-action: none; }
  p { color: #8ea0b8; font-size: 13px; text-align: center; margin-top: 10px; }
</style>
</head>
<body>
<div>
  <canvas id="game" width="420" height="560"></canvas>
  <p>Move with the mouse, arrow keys or WASD. Avoid the blocks. R restarts.</p>
</div>
<script>
(() => {
  const canvas = document.getElementById('game')
  const ctx = canvas.getContext('2d')
  const W = 420, H = 560
  const player = { x: W / 2, y: H - 70, r: 14, speed: 320 }
  const keys = new Set()
  let blocks, score, best, spawnIn, running, last, time

  try { best = Number(localStorage.getItem('skydodge.best')) || 0 } catch { best = 0 }

  function reset() {
    player.x = W / 2
    blocks = []
    score = 0
    spawnIn = 0.4
    running = true
    time = 0
  }

  function gameOver() {
    running = false
    if (score > best) {
      best = score
      try { localStorage.setItem('skydodge.best', String(best)) } catch {}
    }
  }

  function update(dt) {
    if (!running) return
    time += dt
    const speed = 150 + Math.min(240, time * 9)
    if (keys.has('ArrowLeft') || keys.has('KeyA')) player.x -= player.speed * dt
    if (keys.has('ArrowRight') || keys.has('KeyD')) player.x += player.speed * dt
    player.x = Math.max(player.r, Math.min(W - player.r, player.x))

    spawnIn -= dt
    if (spawnIn <= 0) {
      blocks.push({ x: Math.random() * (W - 60) + 30, y: -20, s: 34 + Math.random() * 26, vy: speed })
      spawnIn = Math.max(0.22, 0.62 - time * 0.012)
    }
    for (const b of blocks) b.y += b.vy * dt
    blocks = blocks.filter((b) => b.y < H + 60)
    for (const b of blocks) {
      if (!b.passed && b.y > player.y + player.r) { b.passed = true; score += 1 }
      const nx = Math.max(b.x - b.s / 2, Math.min(player.x, b.x + b.s / 2))
      const ny = Math.max(b.y - b.s / 2, Math.min(player.y, b.y + b.s / 2))
      if (Math.hypot(player.x - nx, player.y - ny) < player.r) gameOver()
    }
  }

  function draw() {
    const sky = ctx.createLinearGradient(0, 0, 0, H)
    sky.addColorStop(0, '#101c33'); sky.addColorStop(1, '#1d3350')
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H)

    // Slow starfield gives a sense of speed without extra state.
    ctx.fillStyle = '#ffffff22'
    for (let i = 0; i < 60; i++) {
      const x = (i * 97) % W
      const y = ((i * 53 + time * 40) % H)
      ctx.fillRect(x, y, 2, 2)
    }

    ctx.fillStyle = '#ffb04d'
    for (const b of blocks) {
      ctx.beginPath(); ctx.roundRect(b.x - b.s / 2, b.y - b.s / 2, b.s, b.s, 6); ctx.fill()
    }
    ctx.fillStyle = '#5ee7a0'
    ctx.beginPath(); ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2); ctx.fill()

    ctx.fillStyle = '#ffffff'
    ctx.font = '700 34px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(String(score), W / 2, 52)
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillStyle = '#8ea0b8'
    ctx.fillText('Best ' + best, W / 2, 74)

    if (!running) {
      ctx.fillStyle = '#0b1220cc'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = '#fff'; ctx.font = '700 30px system-ui, sans-serif'
      ctx.fillText('Game over', W / 2, H / 2 - 12)
      ctx.font = '15px system-ui, sans-serif'; ctx.fillStyle = '#8ea0b8'
      ctx.fillText('Score ' + score + ' · click or press R', W / 2, H / 2 + 20)
    }
  }

  function frame(now) {
    const dt = Math.min(0.033, (now - (last ?? now)) / 1000)
    last = now
    update(dt)
    draw()
    requestAnimationFrame(frame)
  }

  addEventListener('keydown', (e) => {
    keys.add(e.code)
    if (e.code === 'KeyR' && !running) reset()
    if (e.code === 'Space' && !running) reset()
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault()
  })
  addEventListener('keyup', (e) => keys.delete(e.code))
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect()
    player.x = ((e.clientX - rect.left) / rect.width) * W
  })
  canvas.addEventListener('pointerdown', () => { if (!running) reset() })

  reset()
  requestAnimationFrame(frame)
})()
</script>
</body>
</html>
`

const THREE_SCENE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3D Scene</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0b1220; }
  canvas { display: block; }
  #hud { position: fixed; left: 16px; bottom: 14px; color: #8ea0b8; font: 13px system-ui, sans-serif; }
</style>
</head>
<body>
<div id="hud">Drag to orbit · scroll to zoom</div>
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/"
} }
</script>
<script type="module">
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const scene = new THREE.Scene()
scene.background = new THREE.Color('#0b1220')
scene.fog = new THREE.Fog('#0b1220', 8, 22)

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100)
camera.position.set(3.2, 2.4, 4.6)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0.6, 0)

scene.add(new THREE.HemisphereLight('#bcd6ff', '#1a2233', 1.1))
const key = new THREE.DirectionalLight('#ffffff', 2.4)
key.position.set(4, 6, 3)
key.castShadow = true
scene.add(key)
const rim = new THREE.PointLight('#5ee7a0', 30, 20)
rim.position.set(-3, 1.5, -2)
scene.add(rim)

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 64),
  new THREE.MeshStandardMaterial({ color: '#111a2b', roughness: 0.9, metalness: 0.1 }),
)
floor.rotation.x = -Math.PI / 2
floor.receiveShadow = true
scene.add(floor)

const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(0.95, 0.3, 220, 32),
  new THREE.MeshStandardMaterial({ color: '#d3ef74', roughness: 0.25, metalness: 0.55 }),
)
knot.position.y = 1.2
knot.castShadow = true
scene.add(knot)

// A ring of small cubes makes the scene feel designed rather than a lone object.
const cubes = new THREE.Group()
for (let i = 0; i < 12; i++) {
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.22, 0.22),
    new THREE.MeshStandardMaterial({ color: '#5ee7a0', roughness: 0.4 }),
  )
  const angle = (i / 12) * Math.PI * 2
  cube.position.set(Math.cos(angle) * 3.1, 0.25, Math.sin(angle) * 3.1)
  cube.castShadow = true
  cubes.add(cube)
}
scene.add(cubes)

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime()
  knot.rotation.y = t * 0.5
  knot.rotation.x = Math.sin(t * 0.4) * 0.25
  knot.position.y = 1.2 + Math.sin(t * 1.2) * 0.12
  cubes.rotation.y = -t * 0.25
  cubes.children.forEach((cube, i) => { cube.position.y = 0.25 + Math.sin(t * 2 + i) * 0.12 })
  controls.update()
  renderer.render(scene, camera)
})
</script>
</body>
</html>
`

const WEB_APP = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tasks</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: start center; padding: 48px 16px;
    background: #0f1512; color: #e8f0e9; font-family: system-ui, sans-serif;
  }
  main { width: min(560px, 100%); }
  h1 { margin: 0 0 20px; font-size: 28px; letter-spacing: -0.02em; }
  form { display: flex; gap: 8px; margin-bottom: 18px; }
  input[type=text] {
    flex: 1; padding: 12px 14px; border: 1px solid #2b352d; border-radius: 8px;
    background: #161d18; color: inherit; font: inherit; outline: none;
  }
  input[type=text]:focus { border-color: #7b8e4a; }
  button {
    padding: 12px 16px; border: 1px solid #485c33; border-radius: 8px;
    background: #26331f; color: #d3ef74; font: inherit; cursor: pointer;
  }
  button:hover { background: #2f3f26; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px;
    border: 1px solid #232b25; border-radius: 8px; background: #141a15;
  }
  li.done span { color: #7f8a81; text-decoration: line-through; }
  li span { flex: 1; }
  li button { padding: 6px 10px; border-color: #4a2b2b; background: #2a1b1b; color: #f0b4b4; }
  .empty { color: #7f8a81; font-size: 14px; }
  .count { margin-top: 18px; color: #7f8a81; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Tasks</h1>
  <form id="form">
    <input id="input" type="text" placeholder="What needs doing?" autocomplete="off" aria-label="New task">
    <button type="submit">Add</button>
  </form>
  <ul id="list"></ul>
  <p class="count" id="count"></p>
</main>
<script>
(() => {
  const KEY = 'tasks.v1'
  const form = document.getElementById('form')
  const input = document.getElementById('input')
  const list = document.getElementById('list')
  const count = document.getElementById('count')
  let tasks = []
  try { tasks = JSON.parse(localStorage.getItem(KEY)) || [] } catch { tasks = [] }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(tasks)) } catch {}
  }

  function render() {
    list.innerHTML = ''
    if (!tasks.length) {
      const empty = document.createElement('li')
      empty.className = 'empty'
      empty.textContent = 'Nothing yet — add your first task.'
      list.appendChild(empty)
    }
    tasks.forEach((task) => {
      const item = document.createElement('li')
      if (task.done) item.className = 'done'

      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = task.done
      box.setAttribute('aria-label', 'Done: ' + task.text)
      box.addEventListener('change', () => {
        task.done = box.checked
        save(); render()
      })

      const label = document.createElement('span')
      label.textContent = task.text

      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = 'Delete'
      remove.addEventListener('click', () => {
        tasks = tasks.filter((entry) => entry !== task)
        save(); render()
      })

      item.append(box, label, remove)
      list.appendChild(item)
    })
    const left = tasks.filter((task) => !task.done).length
    count.textContent = tasks.length ? left + ' open · ' + tasks.length + ' total' : ''
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text) return
    tasks.push({ text, done: false })
    input.value = ''
    save(); render()
  })

  render()
})()
</script>
</body>
</html>
`

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Product</title>
<style>
  * { box-sizing: border-box; }
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b100d; color: #e9f1ea; font-family: system-ui, sans-serif; line-height: 1.55; }
  .wrap { width: min(1080px, 92vw); margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 22px 0; }
  .logo { font-weight: 800; letter-spacing: -0.03em; }
  .logo span { color: #d3ef74; }
  nav a { margin-left: 22px; color: #a9b7ab; text-decoration: none; font-size: 14px; }
  nav a:hover { color: #fff; }
  .hero { padding: 72px 0 56px; }
  .tag {
    display: inline-block; padding: 5px 10px; border: 1px solid #37452f; border-radius: 999px;
    color: #d3ef74; font-size: 12px; letter-spacing: .04em; text-transform: uppercase;
  }
  h1 { margin: 18px 0 14px; font-size: clamp(38px, 6vw, 64px); line-height: 1.03; letter-spacing: -0.04em; }
  .lead { max-width: 56ch; color: #a9b7ab; font-size: 18px; }
  .cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 26px; }
  .cta a {
    padding: 13px 20px; border-radius: 9px; text-decoration: none; font-weight: 600; font-size: 15px;
  }
  .primary { background: #d3ef74; color: #16200f; }
  .secondary { border: 1px solid #37452f; color: #e9f1ea; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); padding: 22px 0 80px; }
  .card { padding: 22px; border: 1px solid #1f2821; border-radius: 12px; background: #111713; }
  .card h3 { margin: 0 0 8px; font-size: 17px; }
  .card p { margin: 0; color: #a9b7ab; font-size: 14px; }
  footer { padding: 26px 0 40px; border-top: 1px solid #1f2821; color: #7d8a80; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">Product<span>.</span></div>
    <nav><a href="#features">Features</a><a href="#start">Get started</a></nav>
  </header>

  <section class="hero">
    <span class="tag">Now in beta</span>
    <h1>Ship the thing<br>you keep postponing.</h1>
    <p class="lead">A short, honest pitch: what this product does, who it is for, and the single result it delivers. Replace this copy with yours.</p>
    <div class="cta" id="start">
      <a class="primary" href="#">Get started free</a>
      <a class="secondary" href="#features">See how it works</a>
    </div>
  </section>

  <section class="grid" id="features">
    <article class="card"><h3>Fast to start</h3><p>No setup maze. Open it and do the first useful thing in under a minute.</p></article>
    <article class="card"><h3>Clear by default</h3><p>One primary action per screen, readable type, and no dashboard noise.</p></article>
    <article class="card"><h3>Yours to keep</h3><p>Export anything you put in. No lock-in, no dark patterns, no surprise bills.</p></article>
  </section>

  <footer>© <span id="year"></span> Product. Built with plain HTML and CSS.</footer>
</div>
<script>document.getElementById('year').textContent = new Date().getFullYear()</script>
</body>
</html>
`

export const PROJECT_TEMPLATES = {
  game: {
    label: 'Canvas game',
    description: 'Playable arcade game with scoring, difficulty ramp, restart and a saved best score.',
    files: { 'index.html': GAME },
  },
  '3d': {
    label: 'Three.js 3D scene',
    description: 'Orbitable 3D scene with lighting, shadows, animation and a responsive canvas.',
    files: { 'index.html': THREE_SCENE },
  },
  'web-app': {
    label: 'Web app',
    description: 'Working task list with add, complete, delete and localStorage persistence.',
    files: { 'index.html': WEB_APP },
  },
  landing: {
    label: 'Landing page',
    description: 'Responsive product landing page with hero, call to action and feature cards.',
    files: { 'index.html': LANDING },
  },
}

export function templateNames() {
  return Object.keys(PROJECT_TEMPLATES)
}

/** Files for a template, prefixed with an optional project folder. */
export function starterFiles(template, folder = '') {
  const entry = PROJECT_TEMPLATES[template]
  if (!entry) return null
  const prefix = String(folder ?? '').replace(/^\.?\//, '').replace(/\/+$/, '')
  return Object.entries(entry.files).map(([path, content]) => ({
    path: prefix ? `${prefix}/${path}` : path,
    content,
  }))
}

import * as THREE from 'https://esm.sh/three@0.159.0';
import nipplejs from 'https://esm.sh/nipplejs@0.10.1';

// Authentication state
const auth = {
  isHost: false,
  isLoggedIn: false,
  username: null,
  room: null,
  db: null
};

// Initialize WebsimSocket
const room = new WebsimSocket();

// Initialize IndexedDB for host
async function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('VoxelQuestAuth', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'username' });
      }
    };
  });
}

// Hash password (simple SHA-256)
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Host functions
async function storeUser(username, passwordHash) {
  return new Promise((resolve, reject) => {
    const transaction = auth.db.transaction(['users'], 'readwrite');
    const store = transaction.objectStore('users');
    const request = store.add({ username, passwordHash });
    
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

async function getUser(username) {
  return new Promise((resolve, reject) => {
    const transaction = auth.db.transaction(['users'], 'readonly');
    const store = transaction.objectStore('users');
    const request = store.get(username);
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Handle auth requests (host only)
let hostMessageHandler = (event) => {
  const data = event.data;
  
  if (!auth.isHost) return;
  
  if (data.type === 'auth-register') {
    getUser(data.username).then(existing => {
      if (existing) {
        room.send({
          type: 'auth-response',
          success: false,
          message: 'Username already exists',
          requestId: data.requestId,
          clientId: data.clientId,
          echo: false
        });
      } else {
        storeUser(data.username, data.passwordHash).then(() => {
          room.send({
            type: 'auth-response',
            success: true,
            message: 'Registration successful',
            requestId: data.requestId,
            clientId: data.clientId,
            echo: false
          });
        }).catch(err => {
          room.send({
            type: 'auth-response',
            success: false,
            message: 'Registration failed',
            requestId: data.requestId,
            clientId: data.clientId,
            echo: false
          });
        });
      }
    });
  } else if (data.type === 'auth-login') {
    getUser(data.username).then(user => {
      if (!user || user.passwordHash !== data.passwordHash) {
        room.send({
          type: 'auth-response',
          success: false,
          message: 'Invalid username or password',
          requestId: data.requestId,
          clientId: data.clientId,
          echo: false
        });
      } else {
        room.send({
          type: 'auth-response',
          success: true,
          message: 'Login successful',
          requestId: data.requestId,
          clientId: data.clientId,
          echo: false
        });
      }
    });
  }
};

// Client auth functions
let authCallbacks = {};

function sendAuthRequest(type, username, password) {
  return new Promise(async (resolve, reject) => {
    const requestId = Math.random().toString(36).substring(7);
    const passwordHash = await hashPassword(password);
    
    authCallbacks[requestId] = (success, message) => {
      delete authCallbacks[requestId];
      if (success) {
        resolve(message);
      } else {
        reject(message);
      }
    };
    
    room.send({
      type: type,
      username,
      passwordHash,
      requestId,
      clientId: room.clientId,
      echo: true
    });
    
    // Timeout after 5 seconds
    setTimeout(() => {
      if (authCallbacks[requestId]) {
        delete authCallbacks[requestId];
        reject('Request timeout - is host online?');
      }
    }, 5000);
  });
}

// Handle auth responses
room.onmessage = (event) => {
  const data = event.data;
  
  // Handle host messages
  hostMessageHandler(event);
  
  // Handle auth responses
  if (data.type === 'auth-response' && data.clientId === room.clientId) {
    const callback = authCallbacks[data.requestId];
    if (callback) {
      callback(data.success, data.message);
    }
  }
};

// UI handlers
async function handleLogin() {
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;
  const messageEl = document.getElementById('login-message');
  
  if (!username || !password) {
    messageEl.textContent = 'Please enter username and password';
    messageEl.className = 'error';
    return;
  }
  
  messageEl.textContent = 'Logging in...';
  messageEl.className = '';
  
  try {
    await sendAuthRequest('auth-login', username, password);
    auth.isLoggedIn = true;
    auth.username = username;
    messageEl.textContent = 'Login successful!';
    messageEl.className = 'success';
    
    setTimeout(() => {
      document.getElementById('login-screen').classList.add('hidden');
      startGame();
    }, 500);
  } catch (error) {
    messageEl.textContent = error;
    messageEl.className = 'error';
  }
}

async function handleRegister() {
  const username = document.getElementById('username-input').value.trim();
  const password = document.getElementById('password-input').value;
  const messageEl = document.getElementById('login-message');
  
  if (!username || !password) {
    messageEl.textContent = 'Please enter username and password';
    messageEl.className = 'error';
    return;
  }
  
  if (password.length < 4) {
    messageEl.textContent = 'Password must be at least 4 characters';
    messageEl.className = 'error';
    return;
  }
  
  messageEl.textContent = 'Registering...';
  messageEl.className = '';
  
  try {
    await sendAuthRequest('auth-register', username, password);
    messageEl.textContent = 'Registration successful! Please login.';
    messageEl.className = 'success';
    document.getElementById('password-input').value = '';
  } catch (error) {
    messageEl.textContent = error;
    messageEl.className = 'error';
  }
}

// Initialize room
async function initAuth() {
  await room.initialize();
  auth.room = room;
  
  // Check if we're the host (first to connect)
  const peerCount = Object.keys(room.peers).length;
  if (peerCount === 1) {
    auth.isHost = true;
    auth.db = await initDB();
    console.log('Running as host - auth server active');
  } else {
    console.log('Running as client');
  }
  
  // Update host indicator in UI
  const hostIndicator = document.getElementById('host-indicator');
  if (hostIndicator) {
    hostIndicator.textContent = auth.isHost ? 'Host: Online' : 'Host: Offline';
    hostIndicator.style.color = auth.isHost ? '#a6ff8a' : '#ff8a8a';
    hostIndicator.style.pointerEvents = 'none';
  }
  
  // Make canvas focusable and clickable so interactions register reliably
  const canvasEl = document.getElementById('gameCanvas');
  if (canvasEl) {
    canvasEl.tabIndex = 0;
    canvasEl.style.outline = 'none';
    canvasEl.addEventListener('click', () => canvasEl.focus());
    // On mobile ensure taps don't get swallowed
    canvasEl.addEventListener('touchstart', () => canvasEl.focus(), { passive: true });
  }
  
  // Set up event listeners after DOM is ready
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('register-btn').addEventListener('click', handleRegister);
  document.getElementById('password-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  });
}

initAuth();

// Game state
const state = {
  player: {
    position: new THREE.Vector3(0, 2, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    lane: 0, // -1, 0, 1 for left, center, right
    lanePosition: 0,
    isGrounded: false,
    isDashing: false,
    dashCooldown: 0,
    health: 3,
    invincible: 0
  },
  game: {
    speed: 20,
    baseSpeed: 20,
    distance: 0,
    score: 0,
    wave: 1,
    combo: 0,
    gameOver: false,
    time: 0,
    coins: 0
  },
  keys: {},
  mobile: {
    joystick: { x: 0, y: 0 }
  },
  obstacles: [],
  collectibles: [],
  platforms: [],
  chunks: [],
  powerUps: [],
  particles: [],
  laneWidth: 4
};

// Three.js setup
const canvas = document.getElementById('gameCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0x87CEEB, 30, 150);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 8, 12);

// Lighting - Roblox-style bright and colorful
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(10, 30, 10);
sunLight.castShadow = true;
sunLight.shadow.camera.left = -40;
sunLight.shadow.camera.right = 40;
sunLight.shadow.camera.top = 40;
sunLight.shadow.camera.bottom = -40;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
scene.add(sunLight);

// Colorful accent lights
const accentLight1 = new THREE.PointLight(0xffff00, 1.5, 40);
accentLight1.position.set(-8, 8, -15);
scene.add(accentLight1);

const accentLight2 = new THREE.PointLight(0xff00ff, 1.5, 40);
accentLight2.position.set(8, 8, -15);
scene.add(accentLight2);

// Player mesh - Roblox character style with shader
const playerGroup = new THREE.Group();

// Custom shader material for player
const playerShaderMaterial = new THREE.ShaderMaterial({
  uniforms: {
    time: { value: 0 },
    baseColor: { value: new THREE.Color(0x0066ff) },
    glowColor: { value: new THREE.Color(0x00ffff) },
    invincible: { value: 0.0 }
  },
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vPosition = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float time;
    uniform vec3 baseColor;
    uniform vec3 glowColor;
    uniform float invincible;
    varying vec3 vNormal;
    varying vec3 vPosition;
    
    void main() {
      vec3 light = normalize(vec3(1.0, 1.0, 1.0));
      float diffuse = max(dot(vNormal, light), 0.3);
      
      vec3 color = baseColor;
      
      // Invincibility effect
      if (invincible > 0.0) {
        float pulse = sin(time * 10.0) * 0.5 + 0.5;
        color = mix(baseColor, glowColor, pulse);
      }
      
      // Edge glow
      float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
      color += glowColor * fresnel * 0.3;
      
      gl_FragColor = vec4(color * diffuse, 1.0);
    }
  `
});

// Body
const bodyGeometry = new THREE.BoxGeometry(1.2, 1.5, 0.8);
const bodyMesh = new THREE.Mesh(bodyGeometry, playerShaderMaterial);
bodyMesh.position.y = 0;
bodyMesh.castShadow = true;
playerGroup.add(bodyMesh);

// Head
const headGeometry = new THREE.BoxGeometry(1, 1, 1);
const headMaterial = new THREE.ShaderMaterial({
  uniforms: {
    time: { value: 0 },
    baseColor: { value: new THREE.Color(0xffcc99) }
  },
  vertexShader: `
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 baseColor;
    varying vec3 vNormal;
    void main() {
      vec3 light = normalize(vec3(1.0, 1.0, 1.0));
      float diffuse = max(dot(vNormal, light), 0.4);
      gl_FragColor = vec4(baseColor * diffuse, 1.0);
    }
  `
});
const headMesh = new THREE.Mesh(headGeometry, headMaterial);
headMesh.position.y = 1.2;
headMesh.castShadow = true;
playerGroup.add(headMesh);

// Arms
const armGeometry = new THREE.BoxGeometry(0.3, 1, 0.3);
const leftArm = new THREE.Mesh(armGeometry, playerShaderMaterial.clone());
leftArm.position.set(-0.75, 0.2, 0);
leftArm.castShadow = true;
playerGroup.add(leftArm);

const rightArm = new THREE.Mesh(armGeometry, playerShaderMaterial.clone());
rightArm.position.set(0.75, 0.2, 0);
rightArm.castShadow = true;
playerGroup.add(rightArm);

// Legs
const legGeometry = new THREE.BoxGeometry(0.4, 1.2, 0.4);
const legShader = new THREE.ShaderMaterial({
  uniforms: {
    baseColor: { value: new THREE.Color(0x003399) }
  },
  vertexShader: `
    varying vec3 vNormal;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 baseColor;
    varying vec3 vNormal;
    void main() {
      vec3 light = normalize(vec3(1.0, 1.0, 1.0));
      float diffuse = max(dot(vNormal, light), 0.3);
      gl_FragColor = vec4(baseColor * diffuse, 1.0);
    }
  `
});
const leftLeg = new THREE.Mesh(legGeometry, legShader);
leftLeg.position.set(-0.3, -1.35, 0);
leftLeg.castShadow = true;
playerGroup.add(leftLeg);

const rightLeg = new THREE.Mesh(legGeometry, legShader.clone());
rightLeg.position.set(0.3, -1.35, 0);
rightLeg.castShadow = true;
playerGroup.add(rightLeg);

scene.add(playerGroup);

// Store references
const playerMesh = playerGroup;
const playerMaterial = playerShaderMaterial;

// World chunk generation
function createChunk(zPos) {
  const chunk = new THREE.Group();
  
  // Base platform - grass blocks with shader
  const grassMaterial = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      chunkZ: { value: zPos }
    },
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      void main() {
        vPosition = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform float chunkZ;
      varying vec3 vPosition;
      varying vec3 vNormal;
      
      void main() {
        vec3 grassBase = vec3(0.0, 0.66, 0.0);
        vec3 grassDark = vec3(0.0, 0.5, 0.0);
        
        float pattern = sin(vPosition.x * 4.0) * sin(vPosition.z * 4.0) * 0.5 + 0.5;
        vec3 color = mix(grassDark, grassBase, pattern);
        
        vec3 light = normalize(vec3(1.0, 1.0, 1.0));
        float diffuse = max(dot(vNormal, light), 0.4);
        
        gl_FragColor = vec4(color * diffuse, 1.0);
      }
    `
  });
  
  const dirtMaterial = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }
    },
    vertexShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      void main() {
        vPosition = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPosition;
      varying vec3 vNormal;
      
      void main() {
        vec3 dirtColor = vec3(0.54, 0.27, 0.07);
        float noise = sin(vPosition.x * 10.0) * cos(vPosition.z * 10.0) * 0.1;
        vec3 color = dirtColor + noise;
        
        vec3 light = normalize(vec3(1.0, 1.0, 1.0));
        float diffuse = max(dot(vNormal, light), 0.3);
        
        gl_FragColor = vec4(color * diffuse, 1.0);
      }
    `
  });
  
  for (let x = -6; x <= 6; x++) {
    for (let z = 0; z < 20; z++) {
      const blockGeometry = new THREE.BoxGeometry(1, 1, 1);
      const material = grassMaterial.clone();
      const block = new THREE.Mesh(blockGeometry, material);
      block.position.set(x, -1, zPos - z);
      block.receiveShadow = true;
      block.castShadow = true;
      chunk.add(block);
      
      // Add dirt layer below
      const dirtBlock = new THREE.Mesh(blockGeometry, dirtMaterial.clone());
      dirtBlock.position.set(x, -2, zPos - z);
      dirtBlock.receiveShadow = true;
      chunk.add(dirtBlock);
    }
  }
  
  // Add decorative blocks on sides
  for (let z = 0; z < 20; z += 3) {
    if (Math.random() > 0.5) {
      const treeHeight = 3 + Math.floor(Math.random() * 2);
      for (let y = 0; y < treeHeight; y++) {
        const trunk = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 1, 0.5),
          new THREE.MeshStandardMaterial({ color: 0x8B4513 })
        );
        trunk.position.set(Math.random() > 0.5 ? -7 : 7, y, zPos - z);
        trunk.castShadow = true;
        chunk.add(trunk);
      }
      
      // Leaves
      const leaves = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2),
        new THREE.MeshStandardMaterial({ color: 0x228B22 })
      );
      leaves.position.set(Math.random() > 0.5 ? -7 : 7, treeHeight, zPos - z);
      leaves.castShadow = true;
      chunk.add(leaves);
    }
  }
  
  scene.add(chunk);
  state.chunks.push({ group: chunk, zPos });
}

// Initialize chunks
for (let i = 0; i < 8; i++) {
  createChunk(-i * 20);
}

// Platform shader for special effects
const platformMaterial = new THREE.ShaderMaterial({
  uniforms: {
    time: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float time;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4(0.0, 0.5, 0.0, 1.0);
    }
  `
});

// Generate obstacles - Roblox style blocks with shaders
function spawnObstacle(zPos) {
  const lanes = [-1, 0, 1];
  const lane = lanes[Math.floor(Math.random() * lanes.length)];
  
  const types = ['block', 'spike', 'wall', 'pillar'];
  const type = types[Math.floor(Math.random() * types.length)];
  
  let mesh;
  if (type === 'block') {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        color1: { value: new THREE.Color(0xff3333) },
        color2: { value: new THREE.Color(0xff0000) }
      },
      vertexShader: `
        varying vec3 vPosition;
        varying vec3 vNormal;
        void main() {
          vPosition = position;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 color1;
        uniform vec3 color2;
        varying vec3 vPosition;
        varying vec3 vNormal;
        
        void main() {
          float pattern = sin(vPosition.y * 2.0 + time) * 0.5 + 0.5;
          vec3 color = mix(color1, color2, pattern);
          
          vec3 light = normalize(vec3(1.0, 1.0, 1.0));
          float diffuse = max(dot(vNormal, light), 0.3);
          
          gl_FragColor = vec4(color * diffuse, 1.0);
        }
      `
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(lane * state.laneWidth, 1, zPos);
  } else if (type === 'spike') {
    const geometry = new THREE.ConeGeometry(1, 3, 8);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        baseColor: { value: new THREE.Color(0xffaa00) }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying float vHeight;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vHeight = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 baseColor;
        varying vec3 vNormal;
        varying float vHeight;
        
        void main() {
          float glow = sin(time * 3.0 + vHeight) * 0.3 + 0.7;
          vec3 color = baseColor * glow;
          
          vec3 light = normalize(vec3(1.0, 1.0, 1.0));
          float diffuse = max(dot(vNormal, light), 0.4);
          
          gl_FragColor = vec4(color * diffuse, 1.0);
        }
      `
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(lane * state.laneWidth, 1.5, zPos);
  } else if (type === 'pillar') {
    const group = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          time: { value: 0 },
          height: { value: i }
        },
        vertexShader: `
          varying vec3 vNormal;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float time;
          uniform float height;
          varying vec3 vNormal;
          
          void main() {
            vec3 color = vec3(0.66, 0.0, 0.0);
            float pulse = sin(time * 2.0 - height) * 0.2 + 0.8;
            color *= pulse;
            
            vec3 light = normalize(vec3(1.0, 1.0, 1.0));
            float diffuse = max(dot(vNormal, light), 0.3);
            
            gl_FragColor = vec4(color * diffuse, 1.0);
          }
        `
      });
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 1, 1.5),
        material
      );
      block.position.y = i;
      block.castShadow = true;
      group.add(block);
    }
    mesh = group;
    mesh.position.set(lane * state.laneWidth, 0, zPos);
  } else {
    const geometry = new THREE.BoxGeometry(3, 4, 1);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        varying vec3 vNormal;
        varying vec2 vUv;
        
        void main() {
          vec3 color = vec3(0.8, 0.0, 0.0);
          float stripes = step(0.5, fract(vUv.y * 8.0 + time));
          color *= 0.7 + stripes * 0.3;
          
          vec3 light = normalize(vec3(1.0, 1.0, 1.0));
          float diffuse = max(dot(vNormal, light), 0.3);
          
          gl_FragColor = vec4(color * diffuse, 1.0);
        }
      `
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(lane * state.laneWidth, 2, zPos);
  }
  
  mesh.castShadow = true;
  scene.add(mesh);
  state.obstacles.push({ mesh, type, lane });
}

// Generate collectibles - Roblox coins with shader
function spawnCollectible(zPos) {
  const lanes = [-1, 0, 1];
  const lane = lanes[Math.floor(Math.random() * lanes.length)];
  
  const geometry = new THREE.CylinderGeometry(0.6, 0.6, 0.2, 16);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec2 vUv;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec3 vNormal;
      varying vec2 vUv;
      
      void main() {
        vec3 gold = vec3(1.0, 0.84, 0.0);
        vec3 darkGold = vec3(0.8, 0.6, 0.0);
        
        float shine = sin(time * 3.0 + vUv.x * 6.28) * 0.5 + 0.5;
        vec3 color = mix(darkGold, gold, shine);
        
        // Edge glow
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.0);
        color += vec3(1.0, 1.0, 0.5) * fresnel * 0.5;
        
        vec3 light = normalize(vec3(1.0, 1.0, 1.0));
        float diffuse = max(dot(vNormal, light), 0.5);
        
        gl_FragColor = vec4(color * diffuse, 1.0);
      }
    `
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(lane * state.laneWidth, 2, zPos);
  
  scene.add(mesh);
  state.collectibles.push({ mesh, collected: false, type: 'coin' });
}

// Power-ups with shader effects
function spawnPowerUp(zPos) {
  const lanes = [-1, 0, 1];
  const lane = lanes[Math.floor(Math.random() * lanes.length)];
  
  const types = ['speed', 'invincibility', 'magnet'];
  const type = types[Math.floor(Math.random() * types.length)];
  
  let color;
  if (type === 'speed') color = new THREE.Color(0x00ffff);
  else if (type === 'invincibility') color = new THREE.Color(0xff00ff);
  else color = new THREE.Color(0xffff00);
  
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      powerColor: { value: color }
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 powerColor;
      varying vec3 vNormal;
      varying vec3 vPosition;
      
      void main() {
        float pulse = sin(time * 4.0) * 0.3 + 0.7;
        vec3 color = powerColor * pulse;
        
        // Glow effect
        float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 3.0);
        color += powerColor * fresnel * 1.5;
        
        // Energy lines
        float lines = step(0.8, fract(vPosition.y * 5.0 + time * 2.0));
        color += vec3(1.0) * lines * 0.3;
        
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(lane * state.laneWidth, 2.5, zPos);
  
  scene.add(mesh);
  state.powerUps.push({ mesh, type, collected: false });
}

// Initial spawn
for (let i = 0; i < 20; i++) {
  const z = -20 - i * 10;
  if (Math.random() > 0.5) {
    spawnObstacle(z);
  }
  if (Math.random() > 0.6) {
    spawnCollectible(z);
  }
  if (Math.random() > 0.9) {
    spawnPowerUp(z);
  }
}

// Collision detection
function checkCollisions() {
  const playerBox = new THREE.Box3().setFromObject(playerMesh);
  
  // Check obstacles
  for (let i = state.obstacles.length - 1; i >= 0; i--) {
    const obs = state.obstacles[i];
    const obsBox = new THREE.Box3().setFromObject(obs.mesh);
    
    if (playerBox.intersectsBox(obsBox) && state.player.invincible <= 0) {
      state.player.health--;
      state.player.invincible = 1; // 1 second invincibility
      
      if (state.player.health <= 0) {
        gameOver();
        return;
      }
      
      // Visual feedback
      playerMaterial.color.setHex(0xff0000);
      setTimeout(() => playerMaterial.color.setHex(0x0066ff), 200);
    }
    
    // Remove obstacles behind player
    if (obs.mesh.position.z > state.player.position.z + 10) {
      scene.remove(obs.mesh);
      state.obstacles.splice(i, 1);
    }
  }
  
  // Check collectibles
  for (let i = state.collectibles.length - 1; i >= 0; i--) {
    const col = state.collectibles[i];
    if (col.collected) continue;
    
    const colBox = new THREE.Box3().setFromObject(col.mesh);
    
    if (playerBox.intersectsBox(colBox)) {
      col.collected = true;
      scene.remove(col.mesh);
      
      if (col.type === 'coin') {
        state.game.coins++;
        state.game.score += 100 * (state.game.combo + 1);
        state.game.combo++;
        createParticles(col.mesh.position, 0xFFD700);
      }
      
      updateUI();
    }
    
    // Remove collectibles behind player
    if (col.mesh.position.z > state.player.position.z + 10) {
      scene.remove(col.mesh);
      state.collectibles.splice(i, 1);
    }
  }
  
  // Check power-ups
  for (let i = state.powerUps.length - 1; i >= 0; i--) {
    const pu = state.powerUps[i];
    if (pu.collected) continue;
    
    const puBox = new THREE.Box3().setFromObject(pu.mesh);
    
    if (playerBox.intersectsBox(puBox)) {
      pu.collected = true;
      scene.remove(pu.mesh);
      
      if (pu.type === 'speed') {
        state.game.speed *= 1.5;
        setTimeout(() => state.game.speed /= 1.5, 5000);
      } else if (pu.type === 'invincibility') {
        state.player.invincible = 5;
      } else if (pu.type === 'magnet') {
        // Attract nearby coins
        state.collectibles.forEach(c => {
          if (!c.collected && c.type === 'coin') {
            const dist = c.mesh.position.distanceTo(state.player.position);
            if (dist < 15) {
              c.mesh.position.lerp(state.player.position, 0.1);
            }
          }
        });
      }
      
      createParticles(pu.mesh.position, pu.mesh.material.color.getHex());
      state.game.score += 500;
      updateUI();
    }
    
    // Remove power-ups behind player
    if (pu.mesh.position.z > state.player.position.z + 10) {
      scene.remove(pu.mesh);
      state.powerUps.splice(i, 1);
    }
  }
}

// Particle effects
function createParticles(position, color) {
  for (let i = 0; i < 10; i++) {
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const material = new THREE.MeshBasicMaterial({ color });
    const particle = new THREE.Mesh(geometry, material);
    
    particle.position.copy(position);
    particle.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 5,
      Math.random() * 5,
      (Math.random() - 0.5) * 5
    );
    particle.life = 1;
    
    scene.add(particle);
    state.particles.push(particle);
  }
}

function gameOver() {
  if (state.game.gameOver) return;
  
  state.game.gameOver = true;
  document.getElementById('final-distance').textContent = Math.floor(state.game.distance);
  document.getElementById('final-score').textContent = state.game.score;
  document.getElementById('game-over').style.display = 'block';
}

function resetGame() {
  state.game.gameOver = false;
  state.game.distance = 0;
  state.game.score = 0;
  state.game.wave = 1;
  state.game.combo = 0;
  state.game.coins = 0;
  state.game.speed = state.game.baseSpeed;
  state.player.position.set(0, 2, 0);
  state.player.velocity.set(0, 0, 0);
  state.player.lane = 0;
  state.player.health = 3;
  state.player.invincible = 0;
  
  // Clear obstacles and collectibles
  state.obstacles.forEach(obs => scene.remove(obs.mesh));
  state.collectibles.forEach(col => scene.remove(col.mesh));
  state.powerUps.forEach(pu => scene.remove(pu.mesh));
  state.particles.forEach(p => scene.remove(p));
  state.obstacles = [];
  state.collectibles = [];
  state.powerUps = [];
  state.particles = [];
  
  // Respawn
  for (let i = 0; i < 20; i++) {
    const z = -20 - i * 10;
    if (Math.random() > 0.5) spawnObstacle(z);
    if (Math.random() > 0.6) spawnCollectible(z);
    if (Math.random() > 0.9) spawnPowerUp(z);
  }
  
  document.getElementById('game-over').style.display = 'none';
  updateUI();
}

// Input handling
window.addEventListener('keydown', (e) => {
  if (state.game.gameOver) return;
  
  state.keys[e.key.toLowerCase()] = true;
  
  if (e.key === ' ' && state.player.isGrounded) {
    state.player.velocity.y = 12;
    state.player.isGrounded = false;
  }
  
  if (e.key === 'a' && state.player.lane > -1) {
    state.player.lane--;
  }
  
  if (e.key === 'd' && state.player.lane < 1) {
    state.player.lane++;
  }
  
  if (e.key === 'shift' && !state.player.isDashing && state.player.dashCooldown <= 0) {
    state.player.isDashing = true;
    state.player.dashCooldown = 1;
  }
});

window.addEventListener('keyup', (e) => {
  state.keys[e.key.toLowerCase()] = false;
});

// Mobile controls
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

if (isMobile) {
  const joystick = nipplejs.create({
    zone: document.getElementById('joystick-container'),
    mode: 'static',
    position: { left: '60px', top: '60px' },
    color: 'white',
    size: 120
  });
  
  joystick.on('move', (evt, data) => {
    if (state.game.gameOver) return;
    const angle = data.angle.radian;
    state.mobile.joystick.x = Math.cos(angle);
  });
  
  joystick.on('end', () => {
    state.mobile.joystick.x = 0;
  });
  
  document.getElementById('jump-btn').addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (state.game.gameOver) return;
    if (state.player.isGrounded) {
      state.player.velocity.y = 12;
      state.player.isGrounded = false;
    }
  });
  
  const dashBtn = document.getElementById('dash-btn');
  dashBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (state.game.gameOver) return;
    if (!state.player.isDashing && state.player.dashCooldown <= 0) {
      state.player.isDashing = true;
      state.player.dashCooldown = 1;
    }
  });
}

// UI updates
function updateUI() {
  document.getElementById('distance').textContent = Math.floor(state.game.distance);
  document.getElementById('score').textContent = state.game.score;
  document.getElementById('speed').textContent = (state.game.speed / state.game.baseSpeed).toFixed(1);
  document.getElementById('wave').textContent = state.game.wave;
  document.getElementById('combo').textContent = state.game.combo;
  
  // Update health display
  let healthBar = document.getElementById('health');
  if (!healthBar) {
    healthBar = document.createElement('div');
    healthBar.id = 'health';
    healthBar.className = 'stat-bar';
    document.getElementById('hud').appendChild(healthBar);
  }
  healthBar.innerHTML = 'Health: ' + '❤️'.repeat(state.player.health);
  
  // Update coins display
  let coinsDisplay = document.getElementById('coins');
  if (!coinsDisplay) {
    coinsDisplay = document.createElement('div');
    coinsDisplay.id = 'coins';
    coinsDisplay.className = 'stat-bar';
    document.getElementById('hud').appendChild(coinsDisplay);
  }
  coinsDisplay.innerHTML = 'Coins: ' + state.game.coins;
  
  if (isMobile) {
    const dashBtn = document.getElementById('dash-btn');
    if (state.player.dashCooldown > 0) {
      dashBtn.classList.add('cooldown');
    } else {
      dashBtn.classList.remove('cooldown');
    }
  }
}

document.getElementById('restart-btn').addEventListener('click', resetGame);

// Physics and movement
function updatePlayer(deltaTime) {
  if (state.game.gameOver) return;
  
  // Auto-move forward
  const currentSpeed = state.player.isDashing ? state.game.speed * 2 : state.game.speed;
  state.player.position.z -= currentSpeed * deltaTime;
  state.game.distance += currentSpeed * deltaTime;
  
  // Gradually increase speed
  state.game.speed = state.game.baseSpeed + Math.floor(state.game.distance / 100) * 2;
  state.game.wave = Math.floor(state.game.distance / 100) + 1;
  
  // Lane switching
  const targetLaneX = state.player.lane * state.laneWidth;
  
  if (isMobile) {
    if (Math.abs(state.mobile.joystick.x) > 0.5) {
      if (state.mobile.joystick.x < 0 && state.player.lane > -1) {
        state.player.lane = -1;
      } else if (state.mobile.joystick.x > 0 && state.player.lane < 1) {
        state.player.lane = 1;
      }
    }
  }
  
  state.player.lanePosition += (targetLaneX - state.player.lanePosition) * 10 * deltaTime;
  state.player.position.x = state.player.lanePosition;
  
  // Gravity and jumping
  state.player.velocity.y -= 35 * deltaTime;
  state.player.position.y += state.player.velocity.y * deltaTime;
  
  // Ground collision
  if (state.player.position.y <= 2) {
    state.player.position.y = 2;
    state.player.velocity.y = 0;
    state.player.isGrounded = true;
  } else {
    state.player.isGrounded = false;
  }
  
  // Dash mechanics
  if (state.player.isDashing) {
    playerMaterial.uniforms.baseColor.value.setHex(0x00ffff);
    playerMaterial.uniforms.glowColor.value.setHex(0x00ffff);
    state.player.isDashing = false;
  } else {
    if (state.player.invincible > 0) {
      playerMaterial.uniforms.invincible.value = 1.0;
      state.player.invincible -= deltaTime;
    } else {
      playerMaterial.uniforms.baseColor.value.setHex(0x0066ff);
      playerMaterial.uniforms.glowColor.value.setHex(0x00ffff);
      playerMaterial.uniforms.invincible.value = 0.0;
    }
  }
  
  if (state.player.dashCooldown > 0) {
    state.player.dashCooldown -= deltaTime;
  }
  
  // Update player mesh
  playerMesh.position.copy(state.player.position);
  
  // Animate player parts
  if (playerMesh.children) {
    const runSpeed = state.game.time * 10;
    playerMesh.children[2].rotation.x = Math.sin(runSpeed) * 0.5; // left arm
    playerMesh.children[3].rotation.x = Math.sin(runSpeed + Math.PI) * 0.5; // right arm
    playerMesh.children[4].rotation.x = Math.sin(runSpeed + Math.PI) * 0.7; // left leg
    playerMesh.children[5].rotation.x = Math.sin(runSpeed) * 0.7; // right leg
  }
  
  // Camera follow
  camera.position.x = state.player.position.x;
  camera.position.y = state.player.position.y + 8;
  camera.position.z = state.player.position.z + 12;
  camera.lookAt(state.player.position.clone().add(new THREE.Vector3(0, 2, -10)));
  
  // Update chunks
  updateVisibleChunks();
  
  // Spawn new obstacles
  if (state.obstacles.length === 0 || state.obstacles[state.obstacles.length - 1].mesh.position.z > state.player.position.z - 100) {
    const spawnZ = state.player.position.z - 120;
    if (Math.random() > 0.4) spawnObstacle(spawnZ);
    if (Math.random() > 0.5) spawnCollectible(spawnZ);
    if (Math.random() > 0.95) spawnPowerUp(spawnZ);
  }
  
  // Reset combo if no collection
  if (state.game.time % 5 < deltaTime && state.game.combo > 0) {
    state.game.combo = Math.max(0, state.game.combo - 1);
  }
}

// Update visible chunks
function updateVisibleChunks() {
  // Remove old chunks
  for (let i = state.chunks.length - 1; i >= 0; i--) {
    const chunk = state.chunks[i];
    if (chunk.zPos > state.player.position.z + 40) {
      scene.remove(chunk.group);
      state.chunks.splice(i, 1);
    }
  }
  
  // Add new chunks
  if (state.chunks.length === 0 || state.chunks[state.chunks.length - 1].zPos > state.player.position.z - 140) {
    const lastZ = state.chunks.length > 0 ? state.chunks[state.chunks.length - 1].zPos : 0;
    createChunk(lastZ - 20);
  }
}

function updateEffects(deltaTime) {
  // Update platform shader
  platformMaterial.uniforms.time.value += deltaTime;
  
  // Update player shader
  playerMaterial.uniforms.time.value += deltaTime;
  
  // Update chunk shaders
  state.chunks.forEach(chunk => {
    chunk.group.children.forEach(child => {
      if (child.material && child.material.uniforms && child.material.uniforms.time) {
        child.material.uniforms.time.value += deltaTime;
      }
    });
  });
  
  // Animate collectibles
  state.collectibles.forEach(col => {
    if (!col.collected && col.type === 'coin') {
      col.mesh.rotation.y += deltaTime * 5;
      col.mesh.position.y = 2 + Math.sin(Date.now() * 0.003 + col.mesh.position.z) * 0.3;
      if (col.mesh.material.uniforms) {
        col.mesh.material.uniforms.time.value += deltaTime;
      }
    }
  });
  
  // Animate power-ups
  state.powerUps.forEach(pu => {
    if (!pu.collected) {
      pu.mesh.rotation.y += deltaTime * 3;
      pu.mesh.rotation.x += deltaTime * 2;
      pu.mesh.position.y = 2.5 + Math.sin(Date.now() * 0.004 + pu.mesh.position.z) * 0.4;
      if (pu.mesh.material.uniforms) {
        pu.mesh.material.uniforms.time.value += deltaTime;
      }
    }
  });
  
  // Animate obstacles
  state.obstacles.forEach(obs => {
    if (obs.type === 'spike') {
      obs.mesh.rotation.y += deltaTime * 2;
    }
    // Update obstacle shaders
    if (obs.mesh.material && obs.mesh.material.uniforms && obs.mesh.material.uniforms.time) {
      obs.mesh.material.uniforms.time.value += deltaTime;
    }
    // Update pillar shaders
    if (obs.mesh.children) {
      obs.mesh.children.forEach(child => {
        if (child.material && child.material.uniforms && child.material.uniforms.time) {
          child.material.uniforms.time.value += deltaTime;
        }
      });
    }
  });
  
  // Update particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const particle = state.particles[i];
    particle.position.add(particle.velocity.clone().multiplyScalar(deltaTime));
    particle.velocity.y -= 20 * deltaTime; // gravity
    particle.life -= deltaTime;
    particle.material.opacity = particle.life;
    
    if (particle.life <= 0) {
      scene.remove(particle);
      state.particles.splice(i, 1);
    }
  }
  
  // Update game time
  state.game.time += deltaTime;
}

// Game loop
let lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  
  const currentTime = performance.now();
  const deltaTime = (currentTime - lastTime) / 1000;
  lastTime = currentTime;
  
  updatePlayer(deltaTime);
  updateEffects(deltaTime);
  checkCollisions();
  updateUI();
  
  renderer.render(scene, camera);
}

// Start game after login
function startGame() {
  updateUI();
  animate();
}

// Don't auto-start
// updateUI();
// animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
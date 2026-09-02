// Bundled separately from the game: the exporter is only needed by the
// asset pipeline and has no business in a 1.3 MB game bundle.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
globalThis.__mergeDeps = { THREE, GLTFLoader, GLTFExporter };

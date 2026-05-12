/**
 * code.ts
 * 
 * Runs in Figma's plugin sandbox.
 * Has access to figma.* API but NO access to DOM or fetch().
 * Communicates with ui.html exclusively via postMessage.
 */

figma.showUI(__html__, { width: 420, height: 760, title: 'Bloom' });

figma.ui.onmessage = async (msg) => {
  // message handlers will be added in later steps
};

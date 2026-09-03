import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app intentionally imports small, side-effect-free helpers from the
  // checkout's core lib/ layer, so Turbopack must resolve from the checkout
  // root rather than treating web/ as an isolated workspace.
  turbopack: { root: path.resolve(import.meta.dirname, "..") },
  // Allow a throwaway build dir (e.g. BUILD_DIST=.next-prod) so a production
  // `next build` can run without clobbering a live `next dev` .next.
  ...(process.env.BUILD_DIST ? { distDir: process.env.BUILD_DIST } : {}),
};

export default nextConfig;

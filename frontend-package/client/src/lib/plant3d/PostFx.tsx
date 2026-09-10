/**
 * The post-processing chain — moved out of `Plant3D.tsx` (plan §4.D.6).
 *
 * Chain, in order: N8AO -> SMAA -> TiltShift -> ToneMapping -> LUT.
 *
 * ---------------------------------------------------------------------------
 * Why LUT is LAST, not where an earlier draft of the plan listed it
 * ---------------------------------------------------------------------------
 * The visual-overhaul plan's prose (§4.D.6) first listed the chain as
 * "N8AO -> Outline -> SMAA -> LUT -> TiltShift -> ToneMapping". Two things
 * changed that, both from the plan's own §6a Codex-audit corrections:
 *   - Outline is gone outright — a post-process `Outline`/`Selection` cannot
 *     select one instance of an `InstancedMesh` (it would outline the whole
 *     group), so selection is a proxy mesh (`siloSelection.tsx`) instead.
 *   - LUT moves to the END of the chain: "LUT unspecified | Built at runtime
 *     with `LookupTexture` (no PNG), placed after tone mapping, authored on
 *     display-referred values." `LUT3DEffect`'s default `inputColorSpace` is
 *     `SRGBColorSpace` — it expects to grade the DISPLAY-referred image, and
 *     `ToneMapping` is what produces that from the scene's linear HDR values.
 *     A LUT authored (as this one is, see `lut.ts`) against a normal 0..1
 *     display-referred range would be reading un-tonemapped HDR values >1.0
 *     if it ran first, which is not what its own maths assume. See `lut.ts`'s
 *     header for the full argument and `scripts/verify-lut.mjs` for the
 *     executable proof (a neutral LUT in this exact chain position is a
 *     pixel-for-pixel no-op).
 * TiltShift keeps its original position ahead of ToneMapping — it is a
 * screen-space blur, not a colour operation, and ordering it relative to AO/
 * AA (rather than relative to the colour stages) is what a blur pass cares
 * about.
 *
 * ---------------------------------------------------------------------------
 * Tiering — unchanged shape from the pre-rebuild `PostFx`, retargeted
 * ---------------------------------------------------------------------------
 * `PerformanceMonitor` in `Plant3D.tsx` still drives a 0-3 tier. Tier 1 drops
 * TiltShift (a full-frame blur pass, the next most expensive thing here after
 * AO); tier 2 drops N8AO; tier 3 drops SMAA. LUT and ToneMapping never go —
 * dropping ToneMapping would clip every value above 1.0 to flat white (see
 * the extensive note preserved from the original `PostFx` in the git history
 * / delivery report), and LUT is one cheap 3D-texture sample, not worth
 * shedding for the machines this tiering exists to rescue.
 *
 * ---------------------------------------------------------------------------
 * TiltShift strength driven by camera distance
 * ---------------------------------------------------------------------------
 * Plan §3.1 / §4.D.6: "TiltShift at low strength only at whole-site distance,
 * fading out by ~120 m". `TiltShiftEffect` (postprocessing 6.39,
 * `src/effects/TiltShiftEffect.js`) exposes `focusArea`/`feather`/`offset`/
 * `rotation` as real property setters (each pokes a uniform + recomputes a
 * small `maskParams` uniform — no shader recompile, no render-target
 * resize), so those COULD be animated per frame. But the base `Effect` class
 * (`src/core/Effect.js`) already exposes exactly the primitive this job
 * needs — `effect.blendMode.opacity` (a `Uniform`, read via `.value`, or via
 * the `getOpacity()`/`setOpacity()` accessors) — which fades the effect's
 * entire contribution in and out with a single per-frame uniform write and
 * no change to the blur geometry itself. That is cheaper and simpler than
 * reshaping `focusArea`/`feather` every frame to fake the same fade, so this
 * file drives distance -> `blendMode` opacity instead.
 */
import { useEffect, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, N8AO, SMAA, ToneMapping, LUT, TiltShift } from '@react-three/postprocessing';
import { ToneMappingMode, KernelSize } from 'postprocessing';
import type { TiltShiftEffect } from 'postprocessing';
import * as THREE from 'three';
import { makeCoolNeutralLUT, makeNeutralLUT } from './lut';

/**
 * DEV-only override so `scripts/verify-lut.mjs` can drive which LUT (or
 * none) the chain uses without a rebuild — the executable proof that a
 * neutral LUT, in this exact chain position, is a pixel-for-pixel no-op
 * against having no LUT at all, AND that the real grade is NOT a no-op
 * (the "every check must be proven able to fail" rule this project holds
 * every other check to). Read once per render via `window.__plant3dLutMode`:
 *   undefined  -> the real cool-neutral grade (default, production)
 *   'neutral'  -> an identity `LookupTexture` (should match 'off', within 1/255)
 *   'off'      -> no `<LUT>` effect in the chain at all (the baseline)
 * Stripped from production reasoning by the `import.meta.env.DEV` guard.
 */
declare global {
  interface Window {
    __plant3dLutMode?: 'neutral' | 'off';
  }
}

/** How much of the post chain is running. 0 is everything, 3 is the least. */
export type PostTier = 0 | 1 | 2 | 3;

/** Distance (world metres, camera to orbit target) at which TiltShift is at
 *  full strength — whole-site range. */
const TILT_FULL_AT = 200;
/** Distance below which TiltShift is fully faded out — inside a zone, where
 *  a blurred edge would read as an out-of-focus silo rather than a miniature-
 *  model depth cue. */
const TILT_ZERO_AT = 120;

interface OrbitLikeTarget {
  target: THREE.Vector3;
}

/** Fades `TiltShiftEffect`'s own blend opacity by camera-to-target distance.
 *  A separate small component (not inlined in `PostFx` below) so the
 *  `useFrame` subscription only exists while TiltShift is actually mounted —
 *  tier 1+ drops the `<TiltShift>` element entirely, and this goes with it. */
function TiltShiftDistanceDrive({ effectRef }: { effectRef: RefObject<TiltShiftEffect> }) {
  const controls = useThree((s) => s.controls) as unknown as OrbitLikeTarget | null;

  useFrame((state) => {
    const effect = effectRef.current;
    if (!effect) return;
    const target = controls?.target;
    const dist = target ? state.camera.position.distanceTo(target) : 0;
    const t = THREE.MathUtils.clamp((dist - TILT_ZERO_AT) / (TILT_FULL_AT - TILT_ZERO_AT), 0, 1);
    effect.blendMode.opacity.value = t;
  });

  return null;
}

/** Polls `window.__plant3dLutMode` once a frame (DEV only — cheap, and this
 *  entire hook is a no-op string comparison in production where the global
 *  is never set) so `verify-lut.mjs` can flip it via CDP and see the chain
 *  react on the next rendered frame, without a rebuild. */
function useLutModeOverride(): 'neutral' | 'off' | undefined {
  const [mode, setMode] = useState<'neutral' | 'off' | undefined>(
    import.meta.env.DEV ? window.__plant3dLutMode : undefined,
  );
  useFrame(() => {
    if (!import.meta.env.DEV) return;
    const current = window.__plant3dLutMode;
    if (current !== mode) setMode(current);
  });
  return mode;
}

export const PostFx = ({ tier }: { tier: PostTier }) => {
  const lutOverride = useLutModeOverride();
  const grade = useMemo(() => makeCoolNeutralLUT(), []);
  const neutral = useMemo(() => makeNeutralLUT(), []);
  useEffect(() => () => grade.dispose(), [grade]);
  useEffect(() => () => neutral.dispose(), [neutral]);
  const lut = lutOverride === 'neutral' ? neutral : grade;

  /* Typed loosely: the wrapper's own `.d.ts` types the ref as
     `RefAttributes<typeof TiltShiftEffect>` (the CLASS, not an instance) —
     almost certainly a typing slip in the wrapper rather than intent, since
     every other effect wrapper in this package forwards to a constructed
     instance the same way. Cast at the one call site below rather than
     fighting that type here. */
  const tiltRef = useRef<TiltShiftEffect>(null!);

  /*
   * Built as a filtered array rather than as `{cond && <Effect/>}` children.
   *
   * EffectComposer types its children as elements and walks them to merge
   * compatible effects into a single pass, so a literal `false` in that list is
   * both a type error and something it would have to reason about.
   */
  const passes = [
    /* Ambient occlusion: contact grounding for 131+ vessels standing on a
       flat plane. Second to go under load. Retuned per plan §4.D.5/§6a:
       radius 2.5 (was 6 — the old radius muddied the gaps between banks
       rather than reading as contact), intensity 1.4 (was 2.2), colour
       `#26303a`, half-res, distanceFalloff 1.0 (was 1.2). No `ContactShadows`
       (audit: "25 renders per bake, re-bakes on rerender" for the 5-instance
       plan the design doc first proposed) — N8AO plus the sun's own shadow
       map (which now follows the framing box, see `Plant3D.tsx`'s
       `ShadowFollow`) carry contact instead. */
    tier < 2 ? (
      <N8AO key="ao" aoRadius={2.5} intensity={1.4} distanceFalloff={1.0} halfRes color="#26303a" />
    ) : null,
    /* Antialiasing. Third to go. */
    tier < 3 ? <SMAA key="smaa" /> : null,
    /*
     * Site-distance depth cue — miniature-model softness at the whole-site
     * view only, faded to zero opacity by ~120 m via `TiltShiftDistanceDrive`
     * (see the file header). First to go under load.
     *
     * MEASURED AND CORRECTED (2026-09-02): the first tuning here — a
     * `focusArea` of 0.42 with the default (MEDIUM) kernel — read as far too
     * strong on a live render: most of the frame smeared, only a thin sharp
     * band across the middle, near yard and far bins both unreadable. The
     * intent (plan §3.1 / §4.D.6) is a SUBTLE cue, not a depth-of-field
     * photograph — a wide, generously feathered focus area and the smallest
     * blur kernel this effect offers keep the softening confined to the very
     * edges of the frame at whole-site range and imperceptible everywhere
     * else. `TiltShiftDistanceDrive` already takes it fully off (opacity 0)
     * under ~120 m; this is what keeps the >=120 m case from reading as an
     * out-of-focus lens rather than a miniature-model depth cue.
     */
    tier < 1 ? (
      <TiltShift
        key="tilt"
        ref={tiltRef as unknown as Ref<typeof TiltShiftEffect>}
        offset={0}
        rotation={0}
        focusArea={0.62}
        feather={0.4}
        kernelSize={KernelSize.VERY_SMALL}
      />
    ) : null,
    /*
     * Tone mapping MUST be in the chain rather than on the renderer, and must
     * never be dropped at any tier — see the note preserved in the file
     * header on why an all-or-nothing fallback that took ToneMapping with it
     * would clip the whole scene white. `exposure` is NOT a prop here: the
     * ToneMapping EFFECT in postprocessing 6.39 has no exposure control
     * (Codex audit finding, plan §6a) — exposure lives on
     * `gl.toneMappingExposure`, set per look in `Plant3D.tsx`'s
     * `ExposureDrive`. Verified the composer actually honours it (swept
     * exposure 0.3/0.5/1.5/2.0 against the live render and read back mean
     * luminance each time — strictly monotonic, see the note on `exposure`
     * in `look.ts`'s day look and the delivery report for the numbers).
     */
    <ToneMapping key="tone" mode={ToneMappingMode.ACES_FILMIC} />,
    /* The site's fixed colour grade — see `lut.ts`. Placed AFTER ToneMapping
       (see the file header): it grades the display-referred image, not the
       scene's linear HDR values. Never dropped by tiering — one 32^3 texture
       sample is not worth shedding, and it is what keeps the look consistent
       across every tier. */
    /* `'off'` (verify-lut.mjs only) omits the effect entirely — the baseline
       the neutral-LUT no-op claim is measured against. */
    lutOverride === 'off' ? null : <LUT key="lut" lut={lut} />,
    /* Not an Effect or a Pass — `EffectComposer`'s own child walk
       (`EffectComposer.js`) only picks up `instanceof Effect`/`instanceof
       Pass`, so a plain `useFrame`-only, render-nothing component sitting in
       this same array is inert to it and simply mounts as an ordinary React
       child. Kept in the SAME array (rather than a second top-level JSX
       child) because the wrapper types `children` as `JSX.Element |
       JSX.Element[]` — a single array satisfies that; two sibling
       expressions (`{passes}` next to `{cond && <X/>}`) do not. */
    tier < 1 ? <TiltShiftDistanceDrive key="tilt-drive" effectRef={tiltRef} /> : null,
  ].filter(Boolean) as JSX.Element[];

  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      {passes}
    </EffectComposer>
  );
};

export default PostFx;

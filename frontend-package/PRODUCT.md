# PRODUCT.md — Hercules / Fakieh feed-mill application

Durable product context for design work. Written 2026-09-01 for the Plant 3D overhaul; applies to the whole frontend.

## What it is
An operations web app for the Fakieh Feed Factory (Old), Jeddah. It reads the plant's PLC through a Flask backend and shows silo stock, orders, weighbridge and truck flow, batch data, alarms and reports. Data flows one way, plant to screen. Nothing here writes to the PLC.

## Who uses it
- **Plant operators** on the floor and in the control room, on a 1280×720 Windows laptop (Intel Iris Xe) and on a 1024×768 tablet. They glance, they do not read. They know bins by number (312, 806), not by position.
- **The production manager**, who scans and sorts: which bins hold what, what is low, what is alarming, what is stale.
- **The client (the boss)** reviews the screens visually and has rejected the 3D view's look four times. Their reactions are the acceptance test.

## The Plant 3D surface (this overhaul's target)
A live 3D "shadow" of all 131 bins in five zones (Yard 18 · Raw 22 · Dosing 38 · Buffer 5 · Finished 48). Each bin shows material (colour), fill level (drawn contents), high-level and lock alarms, and freshness. Mode: **Operate**. Success is an operator reading a bin's state off the model in one look and finding any bin in two actions.

## Non-negotiables (from the design log §2)
1. Never draw a fill the plant did not measure. The 400 series has no quantity tag and never fills.
2. Negative quantities are real; clamp the drawn fill at 0, show the true number.
3. Material colour and status colour never share a channel.
4. One accent colour (cyan), only for selection.
5. Derived sizes are labelled derived; the vertical stretch (1.25× since 2026-09-02, read from `VERTICAL_EXAGGERATION`), the capacity compression and the 1.3 m floor are disclosed in the UI.
6. Silo positions, arrangements and groupings are the client's. They do not move.
7. Counts on screen are over all 131 bins. (The 500-series soya-oil tanks were retired by the client on 2026-09-10 and removed from the model; they were the only bins drawn but not counted.)

## Constraints
- Stack pinned: React 18.3, Vite 5, Tailwind 3.4 (hand-written `light:` variant set in `index.css`, ~86 rules, no ring rules), three 0.169, @react-three/fiber 8.18, drei 9.122, @react-three/postprocessing 2.19 + postprocessing 6.39, framer-motion 11, wouter, TanStack Query.
- Runs on an intranet; no CDN fetches at runtime.
- Must hold ≥ 40 fps static / ≥ 35 orbiting on the Iris Xe at the page's canvas size, dpr 1.5.
- Dark theme is the client's setting; light theme must work too.
- Other pages are not modified by 3D work except through opt-in props.

## Brand
Hercules (turn data into action) and Saudi Tech logos in the sidebar; Fakieh and ASM Process Automation partner logos in the header. Cyan is the app's accent. No other brand colour rules exist.

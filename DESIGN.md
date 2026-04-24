# Design System Inspired by PlayStation

Active style direction for this project. The generated source file lives at `playstation/DESIGN.md`; this root file is the working summary that should guide implementation.

## Theme

- Use a three-surface rhythm: console-black hero/map surfaces, paper-white editorial panels, and PlayStation-blue anchors.
- Keep the product/map as the visual lead. Chrome should feel premium, restrained, and gallery-like, not industrial.
- Avoid BMW-style hard rectangles and all-caps treatment. PlayStation uses rounded media frames, pill CTAs, and quiet display type.

## Tokens

- PlayStation Blue: `#0070cc`
- PlayStation Cyan: `#1eaedb`, reserved for hover/focus/active states
- Link Hover Blue: `#1883fd`
- Dark Link Blue: `#0068bd`
- Console Black: `#000000`
- Shadow Black: `#121314`
- Paper White: `#ffffff`
- Ice Mist: `#f5f7fa`
- Deep Charcoal: `#1f1f1f`
- Body Gray: `#6b6b6b`
- Commerce Orange: `#d53b00`, only for strong warning/buy-style CTAs when needed

## Typography

- Use SST / Playstation SST style stacks with `Arial`, `Helvetica`, `Pretendard`, and `Noto Sans KR` fallbacks.
- Display headlines at 22px+ should be light weight (`300`) with calm line-height around `1.25`.
- Body/UI text can use 400-700 for readability.
- Do not force all-caps labels. Prefer title case or sentence case.

## Components

- Primary buttons are full pills: blue fill, white text, `999px` radius.
- Primary button hover: cyan fill, white border, blue outer ring, and scale lift.
- Inputs are functional and compact: white background, `#cccccc` border, `3px` radius, blue focus ring.
- Feature cards use `19px` to `24px` radius with restrained elevation.
- Standard image/map frames use `12px` to `24px` radius. Never force square corners.

## Application Mapping

- Briefing hero and Orbit View should be a black PlayStation-style feature surface with OSM as the product frame.
- Secondary dashboard modules should sit on white/ice editorial panels below the hero.
- Active states and map controls should use PlayStation Blue at rest and Cyan only on interaction.
- Keep semantic warning/critical colors sparse so the PlayStation blue system remains dominant.

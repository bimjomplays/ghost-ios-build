// Ghost chess: a GhostGames module (see ghost/games.js for the contract) on top of chess.js (games/chess-lib.js) for
// the rules - legal moves, check, mate, stalemate, draws by repetition / 50 moves / insufficient material, promotion,
// castling, en passant. The state is only the move list in SAN ({ h: ["e4", "e5", ...] }): both Ghosts replay it, so
// repetition draws work and the state stays small. White = players[0] (whoever started the match).
// Piece pictures: the "Cburnett" set (Wikimedia Commons, by Colin M.L. Burnett), used under its BSD licence option.
"use strict";
(() => {
  if (typeof GhostGames === "undefined" || typeof GhostChessLib === "undefined") return;
  const { Chess } = GhostChessLib;
  const PIECES = {
"bd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:none; fill-rule:evenodd; fill-opacity:1; stroke:#000000; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.6)\"> <g style=\"fill:#000000; stroke:#000000; stroke-linecap:butt;\"> <path d=\"M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z\"/> <path d=\"M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z\"/> <path d=\"M 25 8 A 2.5 2.5 0 1 1 20,8 A 2.5 2.5 0 1 1 25 8 z\"/> </g> <path d=\"M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18\" style=\"fill:none; stroke:#ffffff; stroke-linejoin:miter;\"/> </g> </svg>",
"bl": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:none; fill-rule:evenodd; fill-opacity:1; stroke:#000000; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.6)\"> <g style=\"fill:#ffffff; stroke:#000000; stroke-linecap:butt;\"> <path d=\"M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.65,38.99 6.68,38.97 6,38 C 7.35,36.54 9,36 9,36 z\"/> <path d=\"M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z\"/> <path d=\"M 25 8 A 2.5 2.5 0 1 1 20,8 A 2.5 2.5 0 1 1 25 8 z\"/> </g> <path d=\"M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18\" style=\"fill:none; stroke:#000000; stroke-linejoin:miter;\"/> </g> </svg>",
"kd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"fill:none; fill-opacity:1; fill-rule:evenodd; stroke:#000000; stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\"> <path d=\"M 22.5,11.63 L 22.5,6\" style=\"fill:none; stroke:#000000; stroke-linejoin:miter;\" id=\"path6570\"/> <path d=\"M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25\" style=\"fill:#000000;fill-opacity:1; stroke-linecap:butt; stroke-linejoin:miter;\"/> <path d=\"M 12.5,37 C 18,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 20,16 10.5,13 6.5,19.5 C 3.5,25.5 12.5,30 12.5,30 L 12.5,37\" style=\"fill:#000000; stroke:#000000;\"/> <path d=\"M 20,8 L 25,8\" style=\"fill:none; stroke:#000000; stroke-linejoin:miter;\"/> <path d=\"M 32,29.5 C 32,29.5 40.5,25.5 38.03,19.85 C 34.15,14 25,18 22.5,24.5 L 22.5,26.6 L 22.5,24.5 C 20,18 10.85,14 6.97,19.85 C 4.5,25.5 13,29.5 13,29.5\" style=\"fill:none; stroke:#ffffff;\"/> <path d=\"M 12.5,30 C 18,27 27,27 32.5,30 M 12.5,33.5 C 18,30.5 27,30.5 32.5,33.5 M 12.5,37 C 18,34 27,34 32.5,37\" style=\"fill:none; stroke:#ffffff;\"/> </g> </svg>",
"kl": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"> <path stroke-linejoin=\"miter\" d=\"M22.5 11.63V6M20 8h5\"/> <path fill=\"#fff\" stroke-linecap=\"butt\" stroke-linejoin=\"miter\" d=\"M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5\"/> <path fill=\"#fff\" d=\"M12.5 37c5.5 3.5 14.5 3.5 20 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7\"/> <path d=\"M12.5 30c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0m-20 3.5c5.5-3 14.5-3 20 0\"/> </g> </svg>",
"nd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:none; fill-opacity:1; fill-rule:evenodd; stroke:#000000; stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.3)\"> <path d=\"M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18\" style=\"fill:#000000; stroke:#000000;\" /> <path d=\"M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10\" style=\"fill:#000000; stroke:#000000;\" /> <path d=\"M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z\" style=\"fill:#ffffff; stroke:#ffffff;\" /> <path d=\"M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z\" transform=\"matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)\" style=\"fill:#ffffff; stroke:#ffffff;\" /> <path d=\"M 24.55,10.4 L 24.1,11.85 L 24.6,12 C 27.75,13 30.25,14.49 32.5,18.75 C 34.75,23.01 35.75,29.06 35.25,39 L 35.2,39.5 L 37.45,39.5 L 37.5,39 C 38,28.94 36.62,22.15 34.25,17.66 C 31.88,13.17 28.46,11.02 25.06,10.5 L 24.55,10.4 z \" style=\"fill:#ffffff; stroke:none;\" /> </g> </svg>",
"nl": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:none; fill-opacity:1; fill-rule:evenodd; stroke:#000000; stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.3)\"> <path d=\"M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18\" style=\"fill:#ffffff; stroke:#000000;\" /> <path d=\"M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10\" style=\"fill:#ffffff; stroke:#000000;\" /> <path d=\"M 9.5 25.5 A 0.5 0.5 0 1 1 8.5,25.5 A 0.5 0.5 0 1 1 9.5 25.5 z\" style=\"fill:#000000; stroke:#000000;\" /> <path d=\"M 15 15.5 A 0.5 1.5 0 1 1 14,15.5 A 0.5 1.5 0 1 1 15 15.5 z\" transform=\"matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)\" style=\"fill:#000000; stroke:#000000;\" /> </g> </svg>",
"pd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <path d=\"m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z\" style=\"opacity:1; fill:#000000; fill-opacity:1; fill-rule:nonzero; stroke:#000000; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:miter; stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\"/> </svg>",
"pl": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <path d=\"m 22.5,9 c -2.21,0 -4,1.79 -4,4 0,0.89 0.29,1.71 0.78,2.38 C 17.33,16.5 16,18.59 16,21 c 0,2.03 0.94,3.84 2.41,5.03 C 15.41,27.09 11,31.58 11,39.5 H 34 C 34,31.58 29.59,27.09 26.59,26.03 28.06,24.84 29,23.03 29,21 29,18.59 27.67,16.5 25.72,15.38 26.21,14.71 26.5,13.89 26.5,13 c 0,-2.21 -1.79,-4 -4,-4 z\" style=\"opacity:1; fill:#ffffff; fill-opacity:1; fill-rule:nonzero; stroke:#000000; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:miter; stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\"/> </svg>",
"qd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"fill:#000000;stroke:#000000;stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round\"> <path d=\"M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z\" style=\"stroke-linecap:butt;fill:#000000\" /> <path d=\"m 9,26 c 0,2 1.5,2 2.5,4 1,1.5 1,1 0.5,3.5 -1.5,1 -1,2.5 -1,2.5 -1.5,1.5 0,2.5 0,2.5 6.5,1 16.5,1 23,0 0,0 1.5,-1 0,-2.5 0,0 0.5,-1.5 -1,-2.5 -0.5,-2.5 -0.5,-2 0.5,-3.5 1,-2 2.5,-2 2.5,-4 -8.5,-1.5 -18.5,-1.5 -27,0 z\" /> <path d=\"M 11.5,30 C 15,29 30,29 33.5,30\" /> <path d=\"m 12,33.5 c 6,-1 15,-1 21,0\" /> <circle cx=\"6\" cy=\"12\" r=\"2\" /> <circle cx=\"14\" cy=\"9\" r=\"2\" /> <circle cx=\"22.5\" cy=\"8\" r=\"2\" /> <circle cx=\"31\" cy=\"9\" r=\"2\" /> <circle cx=\"39\" cy=\"12\" r=\"2\" /> <path d=\"M 11,38.5 A 35,35 1 0 0 34,38.5\" style=\"fill:none; stroke:#000000;stroke-linecap:butt;\" /> <g style=\"fill:none; stroke:#ffffff;\"> <path d=\"M 11,29 A 35,35 1 0 1 34,29\" /> <path d=\"M 12.5,31.5 L 32.5,31.5\" /> <path d=\"M 11.5,34.5 A 35,35 1 0 0 33.5,34.5\" /> <path d=\"M 10.5,37.5 A 35,35 1 0 0 34.5,37.5\" /> </g> </g> </svg>",
"ql": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"fill:#ffffff;stroke:#000000;stroke-width:1.5;stroke-linejoin:round\"> <path d=\"M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z\"/> <path d=\"M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z\"/> <path d=\"M 11.5,30 C 15,29 30,29 33.5,30\" style=\"fill:none\"/> <path d=\"M 12,33.5 C 18,32.5 27,32.5 33,33.5\" style=\"fill:none\"/> <circle cx=\"6\" cy=\"12\" r=\"2\" /> <circle cx=\"14\" cy=\"9\" r=\"2\" /> <circle cx=\"22.5\" cy=\"8\" r=\"2\" /> <circle cx=\"31\" cy=\"9\" r=\"2\" /> <circle cx=\"39\" cy=\"12\" r=\"2\" /> </g> </svg>",
"rd": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:#000000; fill-opacity:1; fill-rule:evenodd; stroke:#000000; stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.3)\"> <path d=\"M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 12.5,32 L 14,29.5 L 31,29.5 L 32.5,32 L 12.5,32 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 L 14,29.5 z \" style=\"stroke-linecap:butt;stroke-linejoin:miter;\" /> <path d=\"M 14,16.5 L 11,14 L 34,14 L 31,16.5 L 14,16.5 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14 L 11,14 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 12,35.5 L 33,35.5 L 33,35.5\" style=\"fill:none; stroke:#ffffff; stroke-width:1; stroke-linejoin:miter;\" /> <path d=\"M 13,31.5 L 32,31.5\" style=\"fill:none; stroke:#ffffff; stroke-width:1; stroke-linejoin:miter;\" /> <path d=\"M 14,29.5 L 31,29.5\" style=\"fill:none; stroke:#ffffff; stroke-width:1; stroke-linejoin:miter;\" /> <path d=\"M 14,16.5 L 31,16.5\" style=\"fill:none; stroke:#ffffff; stroke-width:1; stroke-linejoin:miter;\" /> <path d=\"M 11,14 L 34,14\" style=\"fill:none; stroke:#ffffff; stroke-width:1; stroke-linejoin:miter;\" /> </g> </svg>",
"rl": "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"> <svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 45 45\" width=\"45\" height=\"45\"> <g style=\"opacity:1; fill:#ffffff; fill-opacity:1; fill-rule:evenodd; stroke:#000000; stroke-width:1.5; stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4; stroke-dasharray:none; stroke-opacity:1;\" transform=\"translate(0,0.3)\"> <path d=\"M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z \" style=\"stroke-linecap:butt;\" /> <path d=\"M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14\" style=\"stroke-linecap:butt;\" /> <path d=\"M 34,14 L 31,17 L 14,17 L 11,14\" /> <path d=\"M 31,17 L 31,29.5 L 14,29.5 L 14,17\" style=\"stroke-linecap:butt; stroke-linejoin:miter;\" /> <path d=\"M 31,29.5 L 32.5,32 L 12.5,32 L 14,29.5\" /> <path d=\"M 11,14 L 34,14\" style=\"fill:none; stroke:#000000; stroke-linejoin:miter;\" /> </g> </svg>"
};
  const FILES = "abcdefgh";
  const SQ_RE = /^[a-h][1-8]$/;
  const pieceUrl = (p) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(PIECES[p.type + (p.color === "w" ? "l" : "d")]);
  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  function rebuild(state) {
    const c = new Chess();
    for (const san of (state && state.h) || []) c.move(san);
    return c;
  }
  const toMove = (c) => (c.turn() === "w" ? 0 : 1);
  function status(state) {
    const c = rebuild(state);
    const mover = toMove(c);
    if (c.isCheckmate()) return { turn: null, winner: 1 - mover, draw: false, text: "Checkmate" };
    if (c.isStalemate()) return { turn: null, winner: null, draw: true, text: "Draw by stalemate" };
    if (c.isThreefoldRepetition()) return { turn: null, winner: null, draw: true, text: "Draw by repetition" };
    if (c.isInsufficientMaterial()) return { turn: null, winner: null, draw: true, text: "Draw: not enough pieces to mate" };
    if (c.isDrawByFiftyMoves()) return { turn: null, winner: null, draw: true, text: "Draw by the 50-move rule" };
    return { turn: mover, winner: null, draw: false, text: (c.inCheck() ? "Check · " : "") + (mover === 0 ? "White" : "Black") + " to move", check: c.inCheck() };
  }
  function apply(state, move, by) {
    if (!move || !SQ_RE.test(move.from || "") || !SQ_RE.test(move.to || "")) throw new Error("bad move");
    if (move.promotion != null && !/^[qrbn]$/.test(move.promotion)) throw new Error("bad promotion");
    const c = rebuild(state);
    if (toMove(c) !== by) throw new Error("not your turn");
    let r;
    try { r = c.move({ from: move.from, to: move.to, promotion: move.promotion || undefined }); } catch (e) { r = null; }
    if (!r) throw new Error("illegal move");
    return { h: ((state && state.h) || []).concat([r.san]) };
  }
  function preview(state) {
    const h = (state && state.h) || [];
    if (!h.length) return "New game";
    const n = Math.ceil(h.length / 2);
    return n + (h.length % 2 ? ". " : "... ") + h[h.length - 1];
  }

  function view(container, opts) {
    let state = opts.state, sel = null, dots = [], drag = null, promo = null, suppressClick = 0;
    const me = opts.me; // 0 = white, 1 = black, null = watching
    const flipped = me === 1;
    const root = document.createElement("div");
    root.className = "ghg-chess";
    root.innerHTML = '<div class="ghg-cap ghg-cap-top"></div><div class="ghg-board-wrap"><div class="ghg-board"></div></div><div class="ghg-cap ghg-cap-bottom"></div><div class="ghg-moves"></div>';
    container.appendChild(root);
    // the board is as big as fits (local px: clientWidth ignores the page zoom Ghost uses on the phone, which CSS
    // container units don't in WebKit), leaving room for the two name rows and the move list
    const fit = () => { const s = Math.max(120, Math.min(root.clientWidth - 16, root.clientHeight - 112, 560)); root.style.setProperty("--ghg-size", Math.floor(s) + "px"); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(root);
    fit();
    const boardEl = root.querySelector(".ghg-board");
    const squares = new Map();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const file = flipped ? 7 - f : f, rank = flipped ? r + 1 : 8 - r;
      const sq = FILES[file] + rank;
      const d = document.createElement("div");
      d.className = "ghg-sq " + ((file + rank) % 2 ? "ghg-light" : "ghg-dark");
      d.dataset.sq = sq;
      if (f === 0) { const l = document.createElement("span"); l.className = "ghg-coord ghg-rank"; l.textContent = rank; d.appendChild(l); }
      if (r === 7) { const l = document.createElement("span"); l.className = "ghg-coord ghg-file"; l.textContent = FILES[file]; d.appendChild(l); }
      boardEl.appendChild(d);
      squares.set(sq, d);
    }
    const myTurn = (c) => me != null && status(state).turn === me && toMove(c) === me;
    function paint() {
      const c = rebuild(state);
      const hist = c.history({ verbose: true });
      const last = hist[hist.length - 1];
      const st = status(state);
      const kingInCheck = c.inCheck() ? (() => { for (const row of c.board()) for (const p of row) if (p && p.type === "k" && p.color === c.turn()) return p.square; return null; })() : null;
      for (const [sq, d] of squares) {
        const p = c.get(sq);
        let img = d.querySelector(".ghg-pc");
        if (p) {
          const url = pieceUrl(p);
          if (!img) { img = document.createElement("img"); img.className = "ghg-pc"; img.alt = ""; img.draggable = false; d.appendChild(img); }
          if (img.dataset.p !== p.color + p.type) { img.src = url; img.dataset.p = p.color + p.type; }
        } else if (img) img.remove();
        d.classList.toggle("ghg-last", !!(last && (last.from === sq || last.to === sq)));
        d.classList.toggle("ghg-check", sq === kingInCheck);
        d.classList.toggle("ghg-sel", sq === sel);
        d.classList.toggle("ghg-dot", dots.includes(sq) && !p);
        d.classList.toggle("ghg-ring", dots.includes(sq) && !!p);
        d.classList.toggle("ghg-mine", !!(p && me != null && (p.color === "w" ? 0 : 1) === me && st.turn === me));
      }
      // captured pieces + material, opponent on top
      const taken = { w: [], b: [] }; // pieces each side has taken
      for (const m of hist) if (m.captured) taken[m.color].push(m.captured);
      const material = (arr) => arr.reduce((a, t) => a + VALUES[t], 0);
      const top = flipped ? "w" : "b", bottom = flipped ? "b" : "w";
      const capRow = (el, side) => {
        const other = side === "w" ? "b" : "w";
        const diff = material(taken[side]) - material(taken[other]);
        el.innerHTML = "";
        const nm = document.createElement("span"); nm.className = "ghg-cap-name";
        nm.textContent = (opts.names && opts.names[side === "w" ? 0 : 1]) || (side === "w" ? "White" : "Black");
        el.appendChild(nm);
        const pcs = document.createElement("span"); pcs.className = "ghg-cap-pcs";
        for (const t of taken[side].slice().sort((a, b) => VALUES[b] - VALUES[a])) {
          const i = document.createElement("img"); i.alt = ""; i.src = pieceUrl({ type: t, color: other }); pcs.appendChild(i);
        }
        el.appendChild(pcs);
        if (diff > 0) { const s = document.createElement("span"); s.className = "ghg-cap-diff"; s.textContent = "+" + diff; el.appendChild(s); }
        el.dataset.turn = st.turn != null && st.turn === (side === "w" ? 0 : 1) ? "1" : "0";
      };
      capRow(root.querySelector(".ghg-cap-top"), top);
      capRow(root.querySelector(".ghg-cap-bottom"), bottom);
      // move list
      const ml = root.querySelector(".ghg-moves");
      const h = (state && state.h) || [];
      ml.innerHTML = "";
      for (let i = 0; i < h.length; i += 2) {
        const n = document.createElement("span"); n.className = "ghg-mv-n"; n.textContent = (i / 2 + 1) + "."; ml.appendChild(n);
        for (const san of h.slice(i, i + 2)) { const s = document.createElement("span"); s.className = "ghg-mv"; s.textContent = san; ml.appendChild(s); }
      }
      ml.scrollLeft = ml.scrollWidth;
    }
    function select(sq) {
      const c = rebuild(state);
      if (!myTurn(c)) { sel = null; dots = []; paint(); return; }
      const p = c.get(sq);
      if (p && p.color === c.turn()) { sel = sq; dots = c.moves({ square: sq, verbose: true }).map((m) => m.to); }
      else { sel = null; dots = []; }
      paint();
    }
    function tryMove(from, to) {
      const c = rebuild(state);
      if (!myTurn(c)) return false;
      const legal = c.moves({ square: from, verbose: true }).filter((m) => m.to === to);
      if (!legal.length) return false;
      sel = null; dots = [];
      if (legal.some((m) => m.promotion)) { askPromotion(from, to, c.turn()); paint(); return true; }
      paint();
      opts.onMove({ from, to });
      return true;
    }
    function askPromotion(from, to, color) {
      closePromo();
      promo = document.createElement("div");
      promo.className = "ghg-promo";
      for (const t of ["q", "r", "b", "n"]) {
        const b = document.createElement("button"); b.type = "button"; b.className = "ghg-promo-btn"; b.dataset.piece = t;
        const i = document.createElement("img"); i.alt = t; i.src = pieceUrl({ type: t, color }); b.appendChild(i);
        b.addEventListener("click", (e) => { e.stopPropagation(); closePromo(); opts.onMove({ from, to, promotion: t }); });
        promo.appendChild(b);
      }
      const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "ghg-promo-cancel"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", (e) => { e.stopPropagation(); closePromo(); });
      promo.appendChild(cancel);
      root.querySelector(".ghg-board-wrap").appendChild(promo);
    }
    function closePromo() { if (promo) { promo.remove(); promo = null; } }
    const sqAt = (x, y) => { const rootNode = root.getRootNode(); const el = (rootNode.elementFromPoint ? rootNode : document).elementFromPoint(x, y); const d = el && el.closest && el.closest(".ghg-sq"); return d && boardEl.contains(d) ? d.dataset.sq : null; };
    boardEl.addEventListener("click", (e) => {
      if (Date.now() < suppressClick) return;
      const d = e.target.closest && e.target.closest(".ghg-sq");
      if (!d) return;
      const sq = d.dataset.sq;
      if (sel && sq !== sel && tryMove(sel, sq)) return;
      select(sq === sel ? null : sq);
    });
    // drag a piece with the finger (tap-to-move keeps working); the piece floats under the finger
    boardEl.addEventListener("pointerdown", (e) => {
      const d = e.target.closest && e.target.closest(".ghg-sq");
      const img = d && d.querySelector(".ghg-pc");
      if (!d || !img || !d.classList.contains("ghg-mine")) return;
      const r = img.getBoundingClientRect();
      drag = { from: d.dataset.sq, id: e.pointerId, x0: e.clientX, y0: e.clientY, img, ghost: null, w: r.width, h: r.height, moved: false };
    });
    window.addEventListener("pointermove", onDragMove, { passive: false });
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
    function onDragMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
      if (!drag.moved) {
        drag.moved = true;
        select(drag.from);
        drag.ghost = drag.img.cloneNode(); drag.ghost.className = "ghg-pc ghg-floating";
        const wrap = root.querySelector(".ghg-board-wrap"); wrap.appendChild(drag.ghost);
        drag.img.style.opacity = "0.25";
      }
      e.preventDefault();
      const wrap = root.querySelector(".ghg-board-wrap"), wr = wrap.getBoundingClientRect();
      const k = wr.width / (wrap.offsetWidth || wr.width || 1); // page px per local px (Ghost is zoomed on the phone)
      drag.ghost.style.width = drag.w / k + "px"; drag.ghost.style.height = drag.h / k + "px";
      drag.ghost.style.transform = `translate(${(e.clientX - wr.left) / k - drag.w / k / 2}px, ${(e.clientY - wr.top) / k - drag.h / k * 0.7}px)`;
    }
    function onDragEnd(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      if (!d.moved) return;
      suppressClick = Date.now() + 350;
      if (d.ghost) d.ghost.remove();
      d.img.style.opacity = "";
      const to = sqAt(e.clientX, e.clientY);
      if (!to || to === d.from || !tryMove(d.from, to)) { sel = null; dots = []; paint(); }
    }
    paint();
    return {
      update(next) { state = next; sel = null; dots = []; closePromo(); paint(); },
      destroy() {
        if (ro) ro.disconnect();
        window.removeEventListener("pointermove", onDragMove); window.removeEventListener("pointerup", onDragEnd); window.removeEventListener("pointercancel", onDragEnd);
        root.remove();
      },
      // for Ghost's tests: tap a square the way a finger does
      _tap(sq) { const d = squares.get(sq); if (d) d.click(); },
    };
  }

  GhostGames.register({
    id: "chess",
    name: "Chess",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21h6M8 18h8l-1-6h-6z"/><path d="M9 12 7 8l3 1 2-4 2 4 3-1-2 4"/></svg>',
    minPlayers: 2,
    newGame() { return { h: [] }; },
    apply, status, view, preview,
  });
})();

// Identidad visual compartida de la TUI: una sola constante de marca para que
// la barra, el encabezado, el prompt, las tarjetas, los paneles, los agentes,
// la lista de tareas, las estadísticas y el panel de uso nunca se desalineen.
//
// El glifo es el emoji de dragón `🐉` (U+1F409): ocupa 2 celdas y no lleva
// selector de variación (U+FE0F) ni secuencias ZWJ, así que el ancho visible
// que calcula la TUI es siempre 2. En terminales sin fuente de emoji se ve
// como un cuadro; es la contrapartida aceptada de usar el dragón.

/** Glifo de marca: dragón de 2 celdas, sin selector de variación. */
export const BRAND_GLYPH = "🐉";

/** Fotogramas de trabajo del prompt: dragón y llama, ambos de 2 celdas. */
export const BRAND_FRAMES = ["🐉", "🔥"] as const;

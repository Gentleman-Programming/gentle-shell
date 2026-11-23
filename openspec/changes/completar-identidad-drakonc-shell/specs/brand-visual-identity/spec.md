# Spec Delta

## Purpose

Define la identidad visual de Drakonc Shell en la TUI, el banner de inicio, el launcher, las vistas de personalización y Tower: paleta, glifo de marca y la ilustración del dragón en sus variantes amplia y compacta.

## ADDED Requirements

### Requirement: Paleta de marca
El tema por defecto `Drakonc` SHALL usar fondo `#0d1526`, texto `#e6edf7` y un rojo eléctrico como acento principal. Tower y el launcher SHALL usar los mismos tres valores. Los colores de estado (éxito, aviso, error) SHALL mantener contraste mínimo 4.5:1 sobre el fondo.

#### Scenario: Tema por defecto
- **WHEN** se carga el tema `Drakonc`
- **THEN** las variables de fondo, texto y acento valen `#0d1526`, `#e6edf7` y el rojo eléctrico definido

#### Scenario: Tower
- **WHEN** se abre Tower en el navegador
- **THEN** el fondo de página es `#0d1526`, el texto `#e6edf7` y los acentos de neón usan el rojo de marca en lugar del rosa heredado

#### Scenario: Contraste
- **WHEN** se calcula el contraste de texto, acento, aviso y error sobre `#0d1526`
- **THEN** cada uno es igual o superior a 4.5:1

### Requirement: Glifo de marca
La TUI SHALL usar el emoji de dragón `🐉` (U+1F409, ancho de 2 celdas) como marca en la barra, el encabezado, el prompt, las tarjetas, los paneles, el widget de agentes, la lista de tareas, las estadísticas y el panel de uso. Ninguna superficie propia SHALL mostrar glifos de flor (`✿`, `❀`, `❁`, `✾`). El ancho y la alineación SHALL calcularse con 2 celdas.

#### Scenario: Sin flores heredadas
- **WHEN** se renderizan la barra, el encabezado, el prompt, los paneles, las tarjetas, agentes, todo, estadísticas y uso
- **THEN** ninguna salida contiene `✿`, `❀`, `❁` ni `✾` y la marca es `🐉`

#### Scenario: Ancho de celda
- **WHEN** se mide el glifo de marca con el cálculo de ancho visible de la TUI
- **THEN** ocupa exactamente 2 celdas y ninguna línea que lo contiene supera el ancho disponible

#### Scenario: Animación del prompt
- **WHEN** el prompt está en estado de trabajo
- **THEN** alterna entre fotogramas emoji de 2 celdas (por ejemplo `🐉` y `🔥`), y en modo sin animación muestra `🐉` estático

### Requirement: Nombre de marca en rojo
En la barra y el encabezado, la palabra `drakonc`/`Drakonc` del nombre de marca SHALL pintarse con el color de acento rojo del tema, y `shell`/`Shell` con el color de texto.

#### Scenario: Encabezado
- **WHEN** se renderiza el encabezado o la barra con un tema de marca
- **THEN** `Drakonc` usa el rol de acento rojo y `Shell` el de texto

### Requirement: Dragón del banner, variante amplia
El banner de inicio SHALL mostrar una ilustración de dragón con nivel de detalle comparable a la rosa original (arte Unicode de bloques o Braille, sombreado y silueta reconocible), en rojo Drakonc, junto al logotipo `Drakonc Shell`. Todas las líneas SHALL tener el mismo ancho visible tras normalizar.

#### Scenario: Terminal amplia
- **WHEN** el banner se renderiza en modo completo con ancho mayor o igual al ancho del dragón + 3 + ancho del logotipo + 4
- **THEN** el dragón y el logotipo aparecen lado a lado, centrados, y el texto `Drakonc Shell` se mantiene

#### Scenario: Líneas uniformes
- **WHEN** se mide cada línea del dragón amplio
- **THEN** todas tienen el mismo ancho visible y ninguna contiene tabuladores ni caracteres de ancho doble

### Requirement: Dragón del banner, variante compacta
El banner SHALL incluir una variante compacta del dragón, reconocible y en rojo Drakonc, para terminales donde no cabe la variante amplia. Si tampoco cabe la compacta, SHALL mostrar solo el texto sin arte. El banner MUST NOT desbordar el ancho disponible.

#### Scenario: Terminal estrecha
- **WHEN** el ancho es menor que el requerido por el dragón amplio pero mayor o igual que el de la variante compacta + 2
- **THEN** se muestra la variante compacta centrada y ninguna línea supera el ancho

#### Scenario: Terminal muy estrecha
- **WHEN** el ancho es menor que la variante compacta + 2
- **THEN** no se dibuja arte y ninguna línea supera el ancho

#### Scenario: Animación conservada
- **WHEN** el banner reproduce la animación de escritura del logotipo en cualquier variante
- **THEN** la animación termina en el mismo estado final que sin animación y el centrado no cambia entre fotogramas

### Requirement: Configuración del banner
La personalización visual SHALL presentar la ilustración como "dragón" y conservar la configuración guardada del usuario. El sistema MUST leer la clave existente `showRose` de `banner.json` como interruptor del dragón y MUST NOT renombrarla, migrarla ni reescribir el archivo salvo que el usuario guarde un cambio.

#### Scenario: Configuración existente
- **WHEN** `banner.json` contiene `{ "showRose": false, "showTextLogo": true, "color": "red" }`
- **THEN** el banner no dibuja el dragón y el archivo no se modifica al iniciar

#### Scenario: Vista de personalización
- **WHEN** el usuario abre la personalización visual
- **THEN** la opción se muestra como dragón y la vista previa usa la ilustración del dragón

### Requirement: Recursos de imagen de marca
Los recursos de marca del repositorio (imagen del README, iconos y logotipos de Tower y del launcher) SHALL mostrar el dragón Drakonc con la paleta de marca y MUST NOT mostrar la flor heredada.

#### Scenario: Imagen del README
- **WHEN** se abre el README
- **THEN** la imagen principal muestra el dragón Drakonc sobre `#0d1526`

### Requirement: Compatibilidad de plataformas
La ilustración del banner SHALL limitarse a caracteres Braille y espacios. El glifo de marca `🐉` es el único emoji permitido; su documentación SHALL indicar que requiere una fuente con emoji y cómo se ve en terminales sin ella.

#### Scenario: Banner sin emojis
- **WHEN** se inspecciona el arte del banner
- **THEN** no contiene caracteres de la categoría emoji ni selectores de variación

#### Scenario: Emoji sin selector de variación
- **WHEN** se inspecciona el glifo de marca
- **THEN** es exactamente U+1F409 (o U+1F525 en fotogramas de trabajo), sin selectores de variación ni secuencias ZWJ

const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const VerticalBarBorder = {
  ...EmptyBorder,
  vertical: "┃",
}

// Blank twin of VerticalBarBorder for hover rails: the rail keeps
// border={["left"]} mounted permanently and swaps the character, because
// assigning customBorderChars to a border-less box force-enables all four
// sides (opentui initializeBorder), and toggling the border side would shift
// layout.
export const BlankVerticalBarBorder = {
  ...EmptyBorder,
  vertical: " ",
}

export const EmptyBorder = {
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

export const SplitBorder = {
  customBorderChars: VerticalBarBorder,
}

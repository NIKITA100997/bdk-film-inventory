import type { ThemeConfig } from "antd";

// Палитра и шрифты взяты из презентации БДК (БДК_Презентация_v3_учет_пленок.pptx):
// тёмно-синий — заголовки/шапка, оранжевый — акцентные действия,
// зелёный — успех/подтверждение, Cambria — заголовки, Calibri — текст.
export const palette = {
  navy: "#2C2E3A",
  navyLight: "#4A4D5C",
  gray: "#6B6B68",
  grayMuted: "#8A8C99",
  border: "#DEDEDA",
  borderLight: "#C9C9C6",
  orange: "#C97A2B",
  orangeTint: "#FBF0E3",
  green: "#1D9E75",
  greenTint: "#E7F5EE",
  pageBg: "#F5F5F4",
  cardBg: "#ECECEA",
  white: "#FFFFFF",
};

export const fontHeading = '"Cambria", Georgia, serif';
export const fontBody = '"Calibri", "Segoe UI", Arial, sans-serif';

export const theme: ThemeConfig = {
  token: {
    colorPrimary: palette.orange,
    colorSuccess: palette.green,
    colorTextBase: palette.navy,
    colorText: palette.navy,
    colorTextSecondary: palette.gray,
    colorTextHeading: palette.navy,
    colorBgLayout: palette.pageBg,
    colorBgContainer: palette.white,
    colorBorder: palette.border,
    colorBorderSecondary: palette.border,
    fontFamily: fontBody,
    borderRadius: 10,
  },
  components: {
    Layout: {
      headerBg: palette.navy,
      siderBg: palette.navy,
      bodyBg: palette.pageBg,
    },
    Menu: {
      darkItemBg: palette.navy,
      darkItemSelectedBg: palette.navyLight,
      darkItemColor: "#D6D7DC",
      darkItemHoverColor: palette.white,
    },
    Card: {
      colorBgContainer: palette.cardBg,
      borderRadiusLG: 12,
    },
    Button: {
      borderRadius: 8,
      fontWeight: 600,
    },
  },
};

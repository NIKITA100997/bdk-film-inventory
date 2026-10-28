import type { ThemeConfig } from "antd";

// Палитра и шрифты взяты из презентации БДК (БДК_Презентация_v3_учет_пленок.pptx):
// тёмно-синий — заголовки/шапка, оранжевый — акцентные действия,
// зелёный — успех/подтверждение, Cambria — заголовки, Calibri — текст.
export const palette = {
  navy: "#2C2E3A",
  navyLight: "#4A4D5C",
  gray: "#6B6B68",
  grayMuted: "#6B6B68",
  border: "#DEDEDA",
  borderLight: "#C9C9C6",
  orange: "#C97A2B",
  orangeTint: "#FBF0E3",
  green: "#1D9E75",
  greenTint: "#E7F5EE",
  pageBg: "#F1F1EE",
  // 28.10: карточки белые на тёплом сером фоне — раньше серое на сером, всё сливалось
  cardBg: "#FFFFFF",
  cardInner: "#FAFAF7",
  headTint: "#F3F4F8",
  red: "#C0392B",
  redTint: "#FBEAE8",
  blue: "#2F6FB2",
  blueTint: "#EAF2FB",
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
    // 16.10: поясняющий текст и подсказки в полях — контрастнее (было ~3:1 на сером фоне карточек)
    colorTextTertiary: palette.gray,
    colorTextDescription: palette.gray,
    colorTextPlaceholder: "#8A8C99",
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
      headerFontSize: 16,
    },
    Table: {
      headerBg: palette.headTint,
      headerColor: palette.navy,
      headerSplitColor: "transparent",
      rowHoverBg: palette.orangeTint,
    },
    Tabs: {
      itemSelectedColor: palette.orange,
      inkBarColor: palette.orange,
      titleFontSize: 15,
    },
    Alert: {
      withDescriptionPadding: "12px 16px",
    },
    Button: {
      borderRadius: 8,
      fontWeight: 600,
    },
  },
};

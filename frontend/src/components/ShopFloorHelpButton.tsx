import { useState } from "react";
import { Button, List, Modal, Typography } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";

const FAQ_ITEMS = [
  {
    q: "Нет QR-бирки или камера не считывает код",
    a: "Нажмите лупу (Поиск) в шапке экрана и введите цифровой номер рулона или партии (например, 6005). Если номер неизвестен — найдите материал в «Склад → Остатки» и распечатайте новую этикетку.",
  },
  {
    q: "Рулон порвался или обнаружен брак плёнки",
    a: "В карточке рулона нажмите «Списать» (или «Вернуть» → поставьте галочку «Списать остаток сразу») и выберите причину брака. Ошибочное списание можно отменить в течение 8 секунд кнопкой «Отменить» или прямо в карточке.",
  },
  {
    q: "Выдали не тот цвет или рулон привязался к старому заданию",
    a: "Откройте карточку рулона и в строке «Задание» нажмите «Отвязать». После этого привяжите рулон к нужному заданию либо верните его на склад кнопкой «Вернуть».",
  },
  {
    q: "Не хватает метража в рулоне под текущее задание",
    a: "Оформите возврат с фактическим остатком (если рулон закончился — введите 0 м и отметьте списание остатка). Недостающий метраж запросите со склада в разделе «Заявки участков» или через мастера.",
  },
  {
    q: "Пропал Wi-Fi в цеху",
    a: "Не закрывайте вкладку и продолжайте работу: жёлтый баннер сверху автоматически сохранит отчёты в памяти планшета и отправит их на сервер, как только сеть восстановится.",
  },
];

export default function ShopFloorHelpButton({ size = "small" }: { size?: "small" | "middle" | "large" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} icon={<QuestionCircleOutlined />} onClick={() => setOpen(true)}>
        Что делать, если…
      </Button>
      <Modal
        title="Памятка для цеха и склада"
        open={open}
        onCancel={() => setOpen(false)}
        footer={
          <Button type="primary" onClick={() => setOpen(false)}>
            Понятно
          </Button>
        }
        width="min(560px, 94vw)"
      >
        <List
          itemLayout="vertical"
          size="small"
          dataSource={FAQ_ITEMS}
          renderItem={(item) => (
            <List.Item>
              <Typography.Text strong style={{ display: "block", marginBottom: 4 }}>
                {item.q}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {item.a}
              </Typography.Text>
            </List.Item>
          )}
        />
      </Modal>
    </>
  );
}

import { Alert, Form, Input, Modal, message } from "antd";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../api/client";
import { useAuth } from "../auth/AuthContext";

const MIN_LEN = 6;

type Values = { current_password: string; new_password: string; repeat: string };

/** Смена своего пароля: текущий + новый дважды. forced — после сброса
 * администратором: закрыть нельзя, текущий = выданный временный. */
export default function ChangePasswordModal({
  open,
  onClose,
  forced = false,
}: {
  open: boolean;
  onClose: () => void;
  forced?: boolean;
}) {
  const [form] = Form.useForm<Values>();
  const { refresh } = useAuth();
  const mutation = useMutation({
    mutationFn: (v: Values) =>
      apiClient.post("/auth/change-password", { current_password: v.current_password, new_password: v.new_password }),
    onSuccess: async () => {
      message.success("Пароль изменён");
      form.resetFields();
      if (forced) await refresh();
      onClose();
    },
    onError: (e: { response?: { data?: { detail?: string } } }) =>
      message.error(e.response?.data?.detail ?? "Не удалось сменить пароль"),
  });

  return (
    <Modal
      open={open}
      title={forced ? "Задайте свой пароль" : "Сменить пароль"}
      okText="Сменить"
      cancelText="Отмена"
      confirmLoading={mutation.isPending}
      onOk={() => form.submit()}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      closable={!forced}
      maskClosable={!forced}
      keyboard={!forced}
      cancelButtonProps={forced ? { style: { display: "none" } } : undefined}
      destroyOnHidden
    >
      {forced && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Вы вошли с временным паролем"
          description="Придумайте свой пароль — временный после этого перестанет действовать."
        />
      )}
      <Form form={form} layout="vertical" onFinish={(v) => mutation.mutate(v)} requiredMark={false}>
        <Form.Item
          name="current_password"
          label={forced ? "Временный пароль" : "Текущий пароль"}
          rules={[{ required: true, message: forced ? "Введите временный пароль" : "Введите текущий пароль" }]}
        >
          <Input.Password autoComplete="current-password" autoFocus />
        </Form.Item>
        <Form.Item
          name="new_password"
          label="Новый пароль"
          rules={[
            { required: true, message: "Введите новый пароль" },
            { min: MIN_LEN, message: `Не короче ${MIN_LEN} символов` },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="repeat"
          label="Новый пароль ещё раз"
          dependencies={["new_password"]}
          rules={[
            { required: true, message: "Повторите новый пароль" },
            ({ getFieldValue }) => ({
              validator: (_, v) =>
                !v || v === getFieldValue("new_password") ? Promise.resolve() : Promise.reject(new Error("Пароли не совпадают")),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

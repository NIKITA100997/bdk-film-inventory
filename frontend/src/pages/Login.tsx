import { useState } from "react";
import { Button, Card, Form, Input, Typography, Alert } from "antd";
import { useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import { useAuth } from "../auth/AuthContext";
import { apiClient, POST_LOGIN_REDIRECT_KEY } from "../api/client";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ username: string; password: string }>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // «Забыли пароль?» — заявка администратору (писем система не шлёт).
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotLogin, setForgotLogin] = useState("");
  const redirectPath = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);

  const detail = (e: unknown) => (isAxiosError(e) ? (e.response?.data as { detail?: string } | undefined)?.detail : undefined);

  const onFinish = async (values: { username: string; password: string }) => {
    setError(null);
    setLoading(true);
    try {
      await login(values.username, values.password);
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
      navigate(redirectPath || "/", { replace: true });
    } catch (e) {
      if (isAxiosError(e) && !e.response) {
        setError("Нет связи с сервером — проверьте, что backend запущен");
      } else if (isAxiosError(e) && e.response?.status === 401) {
        setError("Неверный логин или пароль");
      } else if (isAxiosError(e) && (e.response?.status === 429 || e.response?.status === 403)) {
        setError(detail(e) ?? "Вход временно недоступен");
      } else {
        setError("Ошибка входа, попробуйте ещё раз");
      }
    } finally {
      setLoading(false);
    }
  };

  const onForgot = async (values: { username: string }) => {
    setError(null);
    setLoading(true);
    try {
      await apiClient.post("/auth/forgot-password", { username: values.username });
      setForgotSent(true);
    } catch (e) {
      setError(detail(e) ?? "Не удалось отправить заявку, попробуйте ещё раз");
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = () => {
    setForgot(false);
    setForgotSent(false);
    setError(null);
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ textAlign: "center" }}>
          Учёт плёнки БДК
        </Typography.Title>
        {!error && !forgot && redirectPath && (
          <Alert
            type="info"
            showIcon
            message="Сессия истекла — войдите снова, вы вернётесь туда же"
            style={{ marginBottom: 16 }}
          />
        )}
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        {!forgot ? (
          <Form form={form} layout="vertical" onFinish={onFinish}>
            <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
              <Input autoFocus />
            </Form.Item>
            <Form.Item name="password" label="Пароль" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              Войти
            </Button>
            <Button
              type="link"
              block
              style={{ marginTop: 8 }}
              onClick={() => {
                setForgotLogin(form.getFieldValue("username") ?? "");
                setError(null);
                setForgot(true);
              }}
            >
              Забыли пароль?
            </Button>
          </Form>
        ) : forgotSent ? (
          <>
            <Alert
              type="success"
              showIcon
              message="Заявка отправлена администратору"
              description="Он сбросит пароль и передаст вам временный. При входе с ним система попросит задать свой."
              style={{ marginBottom: 16 }}
            />
            <Button block onClick={backToLogin}>
              Ко входу
            </Button>
          </>
        ) : (
          <Form layout="vertical" onFinish={onForgot} initialValues={{ username: forgotLogin }}>
            <Typography.Paragraph type="secondary">
              Введите логин — администратор получит заявку на сброс пароля и выдаст вам временный.
            </Typography.Paragraph>
            <Form.Item name="username" label="Логин" rules={[{ required: true, message: "Введите логин" }]}>
              <Input autoFocus />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              Отправить заявку
            </Button>
            <Button type="link" block style={{ marginTop: 8 }} onClick={backToLogin}>
              Ко входу
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );
}

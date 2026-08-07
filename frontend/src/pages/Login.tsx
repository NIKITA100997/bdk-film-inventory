import { useState } from "react";
import { Button, Card, Form, Input, Typography, Alert } from "antd";
import { useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import { useAuth } from "../auth/AuthContext";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setError(null);
    setLoading(true);
    try {
      await login(values.username, values.password);
      navigate("/", { replace: true });
    } catch (e) {
      if (isAxiosError(e) && !e.response) {
        setError("Нет связи с сервером — проверьте, что backend запущен");
      } else if (isAxiosError(e) && e.response?.status === 401) {
        setError("Неверный логин или пароль");
      } else {
        setError("Ошибка входа, попробуйте ещё раз");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ textAlign: "center" }}>
          Учёт плёнки БДК
        </Typography.Title>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Пароль" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            Войти
          </Button>
        </Form>
      </Card>
    </div>
  );
}

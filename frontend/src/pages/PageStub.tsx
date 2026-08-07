import { Card, Typography } from "antd";

export default function PageStub({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <Typography.Title level={4}>{title}</Typography.Title>
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
    </Card>
  );
}

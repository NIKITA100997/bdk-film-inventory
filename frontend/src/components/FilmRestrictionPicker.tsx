import { useState } from "react";
import { Input, Modal, Select, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPartFilmRestriction, listPartFilmRestrictions } from "../api/partFilmRestrictions";

const NEW_FILM_RESTRICTION = "__new__";

/** Раздел про совместимость с плёнкой ("ламис"/"с кромкой"/"аляска" и
 * т.п.) — пометка на конкретной партии, список видов заранее не
 * зафиксирован (пользователь сам решил, что будет расширять), поэтому
 * выпадающий список умеет заводить новый вариант тут же, без отдельного
 * экрана администрирования. Управляемый компонент (value/onChange),
 * чтобы Form.Item мог использовать его как обычное поле формы. */
export default function FilmRestrictionPicker({ value, onChange }: { value?: string | null; onChange?: (v: string | null) => void }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const restrictionsQuery = useQuery({ queryKey: ["part-film-restrictions"], queryFn: listPartFilmRestrictions });
  const createMutation = useMutation({
    mutationFn: (name: string) => createPartFilmRestriction(name),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["part-film-restrictions"] });
      onChange?.(created.code);
      setCreating(false);
      setDraftName("");
    },
    onError: () => message.error("Не удалось добавить — такое название уже есть?"),
  });
  return (
    <>
      <Select
        allowClear
        placeholder="Без ограничений"
        value={value ?? undefined}
        onChange={(v) => {
          if (v === NEW_FILM_RESTRICTION) {
            setCreating(true);
            return;
          }
          onChange?.(v ?? null);
        }}
        options={[
          ...(restrictionsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name })),
          { value: NEW_FILM_RESTRICTION, label: "+ Добавить новую пометку…" },
        ]}
      />
      <Modal
        title="Новая пометка совместимости с плёнкой"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => draftName.trim() && createMutation.mutate(draftName.trim())}
        okButtonProps={{ loading: createMutation.isPending, disabled: !draftName.trim() }}
        destroyOnHidden
      >
        <Input
          autoFocus
          placeholder="Например: Ламис (толстые плёнки)"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onPressEnter={() => draftName.trim() && createMutation.mutate(draftName.trim())}
        />
      </Modal>
    </>
  );
}

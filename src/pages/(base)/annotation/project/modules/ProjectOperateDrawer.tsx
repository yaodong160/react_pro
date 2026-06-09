import { type FC, useEffect, useState } from 'react';

import { useFormRules } from '@/features/form';
import { fetchGetUserList } from '@/services/api';

const TOOL_TYPES: { label: string; value: Api.Annotation.ToolType }[] = [
  { label: '矩形框', value: 'create-box' },
  { label: '多边形', value: 'create-polygon' },
  { label: '点', value: 'create-point' }
];

const ProjectOperateDrawer: FC<Page.OperateDrawerProps> = ({ form, handleSubmit, onClose, open, operateType }) => {
  const { t } = useTranslation();
  const { defaultRequiredRule } = useFormRules();
  const [userOptions, setUserOptions] = useState<{ label: string; value: string }[]>([]);

  const isEdit = operateType === 'edit';

  useEffect(() => {
    if (open) {
      fetchGetUserList({ current: 1, size: 999 }).then(res => {
        const users = res.data?.records || [];
        setUserOptions(users.map(u => ({ label: u.userName, value: u.userName })));
      }).catch(() => {});
    }
  }, [open]);

  return (
    <ADrawer
      footer={
        <AFlex
          gap={12}
          justify="end"
        >
          <AButton onClick={onClose}>{t('common.cancel')}</AButton>
          <AButton
            type="primary"
            onClick={handleSubmit}
          >
            {t('common.confirm')}
          </AButton>
        </AFlex>
      }
      open={open}
      title={isEdit ? t('page.annotation.project.editProject') : t('page.annotation.project.addProject')}
      width={640}
      onClose={onClose}
    >
      <AForm
        form={form}
        labelCol={{ span: 6 }}
      >
        <AForm.Item
          label={t('page.annotation.project.projectName')}
          name="projectName"
          rules={[defaultRequiredRule]}
        >
          <AInput placeholder={t('page.annotation.project.form.projectName')} />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.description')}
          name="description"
        >
          <AInput.TextArea
            placeholder={t('page.annotation.project.form.description')}
            rows={3}
          />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.members')}
          name="memberIds"
          tooltip={t('page.annotation.project.membersTip')}
        >
          <ASelect
            allowClear
            mode="multiple"
            options={userOptions}
            placeholder={t('page.annotation.project.form.members')}
          />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.classes')}
        >
          <AForm.List name="classes">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <div
                    key={key}
                    style={{ display: 'flex', gap: 8, marginBottom: 8 }}
                  >
                    <AForm.Item
                      {...restField}
                      name={[name, 'name']}
                      rules={[defaultRequiredRule]}
                      style={{ flex: 1, marginBottom: 0 }}
                    >
                      <AInput placeholder={t('page.annotation.project.form.className')} />
                    </AForm.Item>
                    <AButton
                      danger
                      icon={<IconIcRoundClose />}
                      size="small"
                      type="text"
                      onClick={() => remove(name)}
                    />
                  </div>
                ))}
                <AButton
                  block
                  icon={<IconIcRoundAdd />}
                  type="dashed"
                  onClick={() => add({ name: '' })}
                >
                  {t('page.annotation.project.form.addClass')}
                </AButton>
              </>
            )}
          </AForm.List>
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.tags')}
        >
          <AForm.List name="tags">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <div
                    key={key}
                    style={{ display: 'flex', gap: 8, marginBottom: 8 }}
                  >
                    <AForm.Item
                      {...restField}
                      name={name}
                      rules={[defaultRequiredRule]}
                      style={{ flex: 1, marginBottom: 0 }}
                    >
                      <AInput placeholder={t('page.annotation.project.form.tag')} />
                    </AForm.Item>
                    <AButton
                      danger
                      icon={<IconIcRoundClose />}
                      size="small"
                      type="text"
                      onClick={() => remove(name)}
                    />
                  </div>
                ))}
                <AButton
                  block
                  icon={<IconIcRoundAdd />}
                  type="dashed"
                  onClick={() => add('')}
                >
                  {t('page.annotation.project.form.addTag')}
                </AButton>
              </>
            )}
          </AForm.List>
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.tools')}
          name="tools"
          initialValue={['create-box']}
          rules={[defaultRequiredRule]}
        >
          <ASelect
            allowClear
            mode="multiple"
            options={TOOL_TYPES}
            placeholder={t('page.annotation.project.tools')}
          />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.enableComment')}
          name="enableComment"
          valuePropName="checked"
        >
          <ASwitch />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.commentPresets')}
          name="commentPresets"
          tooltip={t('page.annotation.project.commentPresetsTip')}
        >
          <AInput.TextArea
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t('page.annotation.project.commentPresetsPlaceholder')}
          />
        </AForm.Item>

        <ADivider orientation="left" plain>
          {t('page.annotation.project.cameraConfig')}
        </ADivider>

        <AForm.Item
          label={t('page.annotation.project.cameraUrl')}
          name="cameraUrl"
        >
          <AInput
            autoComplete="off"
            placeholder={t('page.annotation.project.form.cameraUrl')}
          />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.cameraUsername')}
          name="cameraUsername"
        >
          <AInput
            autoComplete="off"
            placeholder={t('page.annotation.project.form.cameraUsername')}
          />
        </AForm.Item>

        <AForm.Item
          label={t('page.annotation.project.cameraPassword')}
          name="cameraPassword"
        >
          <AInput.Password
            autoComplete="new-password"
            placeholder={t('page.annotation.project.form.cameraPassword')}
          />
        </AForm.Item>
      </AForm>
    </ADrawer>
  );
};

export default ProjectOperateDrawer;

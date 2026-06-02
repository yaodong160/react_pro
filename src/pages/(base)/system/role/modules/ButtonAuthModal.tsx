import type { DataNode } from 'antd/es/tree';

import { fetchGetRolePermissions, fetchSaveRolePermissions } from '@/services/api';

import type { ModulesProps } from './type';

const ButtonAuthModal: FC<ModulesProps> = memo(({ onClose, open, roleId }) => {
  const { t } = useTranslation();

  const title = t('common.edit') + t('page.system.role.buttonAuth');

  const [checks, setChecks] = useState<React.Key[]>();

  const [tree, setTree] = useState<DataNode[]>();

  const [loading, setLoading] = useState(false);

  async function getChecks() {
    try {
      const { data: res, error } = await fetchGetRolePermissions(roleId);
      console.log('[ButtonAuth] API返回:', { res, error, roleId });
      if (res) {
        setChecks(res.checkedKeys || []);
        if (res.allPermissions) {
          setTree(res.allPermissions as DataNode[]);
        } else {
          console.warn('[ButtonAuth] allPermissions 为空', res);
        }
      }
    } catch (err) {
      console.error('[ButtonAuth] 请求失败:', err);
    }
  }

  async function handleSubmit() {
    if (!checks) {
      return;
    }
    setLoading(true);
    try {
      const permissionIds = checks.map(k => Number(k)).filter(id => !Number.isNaN(id));
      await fetchSaveRolePermissions(roleId, permissionIds);
      window.$message?.success?.(t('common.modifySuccess'));
      onClose();
    } catch {
      window.$message?.error?.('保存失败');
    } finally {
      setLoading(false);
    }
  }

  function init() {
    getChecks();
  }

  useUpdateEffect(() => {
    if (open) {
      init();
    }
  }, [open]);

  return (
    <AModal
      className="w-480px"
      open={open}
      title={title}
      footer={
        <ASpace className="mt-16px">
          <AButton
            size="small"
            onClick={onClose}
          >
            {t('common.cancel')}
          </AButton>
          <AButton
            size="small"
            loading={loading}
            type="primary"
            onClick={handleSubmit}
          >
            {t('common.confirm')}
          </AButton>
        </ASpace>
      }
      onCancel={onClose}
    >
      <ATree
        checkable
        checkedKeys={checks}
        className="h-280px"
        height={280}
        treeData={tree}
        onCheck={value => setChecks(value as number[])}
      />
    </AModal>
  );
});

export default ButtonAuthModal;

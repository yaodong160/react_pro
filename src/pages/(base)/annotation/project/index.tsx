/**
 * @handle {
 *   "icon": "majesticons:folder-line",
 *   "keepAlive": true,
 *   "order": 1
 * }
 */

import { Suspense, lazy } from 'react';

import { useEffectOnActive } from 'keepalive-for-react';

import { TableHeaderOperation, useTable, useTableOperate, useTableScroll } from '@/features/table';
import { fetchAddProject, fetchDeleteProject, fetchEditProject, fetchGetProjectList } from '@/services/api';
import { selectUserInfo } from '@/stores/modules/auth';

import { setCurrentProjectId } from '../store';
import ProjectSearch from './modules/ProjectSearch';

const ProjectOperateDrawer = lazy(() => import('./modules/ProjectOperateDrawer'));

const projectStatusMap: Record<string, string> = {
  active: 'processing',
  completed: 'success'
};

const ProjectManage = () => {
  const { t } = useTranslation();
  const { scrollConfig, tableWrapperRef } = useTableScroll();
  const nav = useNavigate();
  const isMobile = useMobile();
  const userInfo = useAppSelector(selectUserInfo);

  const { columnChecks, data, run, searchProps, setColumnChecks, tableProps } = useTable(
    {
      apiFn: fetchGetProjectList,
      apiParams: {
        current: 1,
        memberId: userInfo.userName,
        projectName: null,
        size: 10,
        status: null
      },
      columns: () => [
        {
          align: 'center',
          key: 'index',
          render: (_, __, index) => index + 1,
          title: '#',
          width: 60
        },
        {
          align: 'center',
          dataIndex: 'projectName',
          key: 'projectName',
          title: t('page.annotation.project.projectName'),
          width: 200
        },
        {
          align: 'center',
          dataIndex: 'description',
          ellipsis: true,
          key: 'description',
          title: t('page.annotation.project.description'),
          width: 300
        },
        {
          align: 'center',
          dataIndex: 'totalImages',
          key: 'totalImages',
          title: t('page.annotation.project.totalImages'),
          width: 100
        },
        {
          align: 'center',
          key: 'annotatedCount' as keyof Api.Annotation.Project,
          render: (_: unknown, record: Api.Annotation.Project) => {
            const percent = record.totalImages > 0
              ? Math.round((record.annotatedCount / record.totalImages) * 100)
              : 0;
            return `${record.annotatedCount}/${record.totalImages} (${percent}%)`;
          },
          title: t('page.annotation.project.annotatedCount'),
          width: 150
        },
        {
          align: 'center',
          dataIndex: 'status',
          key: 'status',
          render: (status: string) => {
            const label = status === 'active' ? t('page.annotation.project.active') : t('page.annotation.project.completed');
            const color = projectStatusMap[status] || 'default';
            return <ATag color={color}>{label}</ATag>;
          },
          title: t('page.annotation.project.status'),
          width: 100
        },
        {
          align: 'center',
          dataIndex: 'createBy',
          key: 'createBy',
          title: t('common.createBy'),
          width: 100
        },
        {
          align: 'center',
          key: 'operate',
          render: (_, record) => (
            <AFlex
              gap={8}
              justify="center"
            >
              <AButton
                size="small"
                type="primary"
                onClick={() => {
                  setCurrentProjectId(record.id);
                  nav('/annotation/collect');
                }}
              >
                {t('page.annotation.image.title')}
              </AButton>
              <AButton
                size="small"
                onClick={() => {
                  setCurrentProjectId(record.id);
                  nav('/annotation/annotate');
                }}
              >
                {t('page.annotation.annotate.title')}
              </AButton>
              <AButton
                size="small"
                onClick={() => nav(`/annotation/project/${record.id}`)}
              >
                {t('common.detail')}
              </AButton>
              <AButton
                size="small"
                type="primary"
                onClick={() => {
                  // 编辑回显时把 commentPresets 数组转为多行文本
                  const recordForEdit = { ...record };
                  if (Array.isArray(record.commentPresets)) {
                    recordForEdit.commentPresets = record.commentPresets.join('\n');
                  }
                  handleEdit(recordForEdit);
                }}
              >
                {t('common.edit')}
              </AButton>
              <APopconfirm
                title={t('common.confirmDelete')}
                onConfirm={() => handleDelete(record.id)}
              >
                <AButton
                  danger
                  size="small"
                >
                  {t('common.delete')}
                </AButton>
              </APopconfirm>
            </AFlex>
          ),
          title: t('common.operate'),
          width: 420
        }
      ]
    }
  );

  const { editingData, generalPopupOperation, handleAdd, handleEdit, onDeleted } = useTableOperate(
    data as any,
    run,
    async (res: any, type) => {
      if (type === 'add') {
        // 校验至少有一项配置
        const classes = (res.classes || []).filter((c: any) => c.name);
        const tags = (res.tags || []).filter((t: any) => t);
        const commentPresets = (res.commentPresets || '').split('\n').filter((c: string) => c.trim());
        const hasConfig = classes.length > 0 || tags.length > 0 || res.enableComment || commentPresets.length > 0;
        if (!hasConfig) {
          window.$message?.warning(t('page.annotation.project.form.configRequired'));
          throw new Error('configRequired');
        }
        // 将 commentPresets 从多行文本转为数组
        res.commentPresets = commentPresets;
        await fetchAddProject(res);
      } else {
        // 编辑时同样转换
        const commentPresets = (res.commentPresets || '').split('\n').filter((c: string) => c.trim());
        res.commentPresets = commentPresets;
        await fetchEditProject(editingData!.id, res);
      }
    }
  );

  async function handleDelete(id: number) {
    await fetchDeleteProject(id);
    onDeleted();
  }

  // keepAlive 激活时刷新项目列表
  useEffectOnActive(() => {
    run();
  }, []);

  return (
    <div className="h-full min-h-500px flex-col-stretch gap-12px overflow-hidden lt-sm:overflow-auto">
      <ACollapse
        bordered={false}
        className="card-wrapper"
        defaultActiveKey={isMobile ? undefined : 'search'}
        items={[
          {
            key: 'search',
            label: t('common.search'),
            children: <ProjectSearch {...searchProps} />
          }
        ]}
      />

      <ACard
        className="flex-col-stretch card-wrapper sm:flex-1-hidden"
        ref={tableWrapperRef}
        title={t('page.annotation.project.title')}
        variant="borderless"
        extra={(
          <TableHeaderOperation
            add={handleAdd}
            columns={columnChecks}
            loading={tableProps.loading}
            refresh={run}
            setColumnChecks={setColumnChecks}
            onDelete={() => {}}
          />
        )}
      >
        <ATable
          scroll={scrollConfig}
          size="small"
          {...tableProps}
        />
        <Suspense fallback={<ASpin />}>
          <ProjectOperateDrawer {...generalPopupOperation} />
        </Suspense>
      </ACard>
    </div>
  );
};

export default ProjectManage;

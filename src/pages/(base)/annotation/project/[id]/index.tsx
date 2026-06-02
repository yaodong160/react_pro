/**
 * @handle {
 *   "activeMenu": "/annotation/project",
 *   "hideInMenu": true,
 *   "title": "项目详情"
 * }
 */

import { type LoaderFunctionArgs, useLoaderData } from 'react-router-dom';

import { fetchGetProjectDetail } from '@/services/api';

type DescriptionsProps = React.ComponentProps<typeof ADescriptions>;

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const projectRes = await fetchGetProjectDetail(Number(params.id));
  return projectRes.data!;
};

const ProjectDetail = () => {
  const { t } = useTranslation();
  const project = useLoaderData() as Awaited<ReturnType<typeof loader>>;

  if (!project) {
    return (
      <div className="h-full flex-center">
        <AResult
          status="warning"
          title={t('common.loading')}
        />
      </div>
    );
  }

  const items: DescriptionsProps['items'] = [
    { key: 'projectName', label: t('page.annotation.project.projectName'), children: project.projectName },
    { key: 'description', label: t('page.annotation.project.description'), children: project.description || '-' },
    { key: 'status', label: t('page.annotation.project.status'), children: project.status === 'active' ? t('page.annotation.project.active') : t('page.annotation.project.completed') },
    { key: 'enableComment', label: t('page.annotation.project.enableComment'), children: project.enableComment ? t('common.yes') : t('common.no') },
    { key: 'tools', label: t('page.annotation.project.tools'), children: project.tools?.join(', ') || '-' },
    { key: 'totalImages', label: t('page.annotation.project.totalImages'), children: project.totalImages },
    { key: 'annotatedCount', label: t('page.annotation.project.annotatedCount'), children: `${project.annotatedCount} / ${project.totalImages}` },
    { key: 'createBy', label: t('common.createBy'), children: project.createBy },
    { key: 'updateBy', label: t('common.updateBy'), children: project.updateBy },
    { key: 'createTime', label: t('common.createTime'), children: project.createTime },
    { key: 'updateTime', label: t('common.updateTime'), children: project.updateTime }
  ];

  return (
    <div className="h-full flex-col gap-16px overflow-auto p-16px">
      <ACard
        title={t('page.annotation.projectDetail.basicInfo')}
      >
        <ADescriptions
          bordered
          column={2}
          items={items}
        />
      </ACard>

      <ACard
        title={t('page.annotation.projectDetail.labelConfig')}
      >
        <div className="flex-col gap-16px">
          <div>
            <h4 className="mb-8px text-16px font-bold">{t('page.annotation.projectDetail.classes')}</h4>
            <div className="flex flex-wrap gap-8px">
              {project.classes?.map((cls: Api.Annotation.ClassItem, idx: number) => (
                <ATag key={idx}>
                  {cls.name}
                </ATag>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-8px text-16px font-bold">{t('page.annotation.projectDetail.tags')}</h4>
            <div className="flex flex-wrap gap-8px">
              {project.tags?.map((tag: string, idx: number) => (
                <ATag key={idx}>{tag}</ATag>
              ))}
            </div>
          </div>
        </div>
      </ACard>
    </div>
  );
};

export default ProjectDetail;

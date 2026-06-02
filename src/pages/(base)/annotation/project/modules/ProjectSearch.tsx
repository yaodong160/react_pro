const ProjectSearch: FC<Page.SearchProps> = memo(({ form, reset, search, searchParams }) => {
  const { t } = useTranslation();

  const statusOptions: CommonType.Option<string>[] = [
    { label: t('page.annotation.project.active'), value: 'active' },
    { label: t('page.annotation.project.completed'), value: 'completed' }
  ];

  return (
    <AForm
      form={form}
      initialValues={searchParams}
      labelCol={{
        md: 7,
        span: 5
      }}
    >
      <ARow
        wrap
        gutter={[16, 16]}
      >
        <ACol
          lg={6}
          md={12}
          span={24}
        >
          <AForm.Item
            className="m-0"
            label={t('page.annotation.project.projectName')}
            name="projectName"
          >
            <AInput placeholder={t('page.annotation.project.form.projectName')} />
          </AForm.Item>
        </ACol>

        <ACol
          lg={6}
          md={12}
          span={24}
        >
          <AForm.Item
            className="m-0"
            label={t('page.annotation.project.status')}
            name="status"
          >
            <ASelect
              allowClear
              options={statusOptions}
              placeholder={t('page.annotation.project.status')}
            />
          </AForm.Item>
        </ACol>

        <ACol
          lg={12}
          span={24}
        >
          <AForm.Item className="m-0">
            <AFlex
              align="center"
              gap={12}
              justify="end"
            >
              <AButton
                icon={<IconIcRoundRefresh />}
                onClick={reset}
              >
                {t('common.reset')}
              </AButton>
              <AButton
                ghost
                icon={<IconIcRoundSearch />}
                type="primary"
                onClick={search}
              >
                {t('common.search')}
              </AButton>
            </AFlex>
          </AForm.Item>
        </ACol>
      </ARow>
    </AForm>
  );
});

export default ProjectSearch;

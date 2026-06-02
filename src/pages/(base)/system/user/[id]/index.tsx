/**
 * @handle {
 *   "activeMenu": "/system/user",
 *   "hideInMenu": true
 * }
 */

import type { DescriptionsProps } from 'antd';
import { type LoaderFunctionArgs, useLoaderData } from 'react-router-dom';

import LookForward from '@/components/LookForward';
import { enableStatusRecord, userGenderRecord } from '@/constants/business';
import { fetchGetUserDetail } from '@/services/api';

type Item<T> = T extends any[] ? T[number] : T;

type ValuesOf<T> = T[keyof T];

type Values = ValuesOf<Api.SystemManage.User>;

const valueMap: Record<string, Record<string, App.I18n.I18nKey>> = {
  userGender: userGenderRecord,
  status: enableStatusRecord
};

function transformDataToItem<T extends string, U extends Values>(
  tuple: [T, U],
  t: (key: string) => string
): NonNullable<Item<DescriptionsProps['items']>> {
  let children: React.ReactNode = tuple[1]; 
  const map = valueMap[tuple[0]]; 
  // console.log(map, tuple[0]);
  if (map && tuple[1] !== null && tuple[1] !== undefined) {
    const i18nKey = map[String(tuple[1])];
    if (i18nKey) {
      children = t(i18nKey);
    }
  }

  return {
    children,
    key: tuple[0],
    label: t(`page.system.user.${tuple[0]}`)
  };
}

const Component = () => {
  const data = useLoaderData() as Api.SystemManage.User | undefined;

  const { t } = useTranslation();

  if (!data) {
    return <LookForward />;
  }

  const items = Object.entries(data).map(item => transformDataToItem(item, t));

  return (
    <ACard
      className="h-full"
      title="用户详情"
    >
      <ADescriptions
        bordered
        items={items}
      />
      <div className="mt-16px text-center text-18px">{t('page.system.userDetail.explain')}</div>

      <div className="mt-16px text-center text-18px">{t('page.system.userDetail.content')}</div>
    </ACard>
  );
};

export async function loader({ params }: LoaderFunctionArgs) {
  const { data, error } = await fetchGetUserDetail(Number(params.id));
  console.log('[UserDetail] loader 结果:', { paramsId: params.id, data, error });
  if (error) {
    return null;
  }
  return data;
}

export default Component;

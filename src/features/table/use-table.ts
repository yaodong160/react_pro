import { useBoolean, useHookTable } from '@chiko-admin/hooks';
import type { TablePaginationConfig, TableProps } from 'antd';
import { Form } from 'antd';

import { parseQuery } from '@/features/router/query';
import { getIsMobile } from '@/stores/modules';

type TableData = AntDesign.TableData;
type GetTableData<A extends AntDesign.TableApiFn> = AntDesign.GetTableData<A>;
type TableColumn<T> = AntDesign.TableColumn<T>;
type Config<A extends AntDesign.TableApiFn> = AntDesign.AntDesignTableConfig<A> & {
  isChangeURL?: boolean;
};

export function useTable<A extends AntDesign.TableApiFn>(
  config: Config<A>,
  paginationConfig?: Omit<TablePaginationConfig, 'current' | 'onChange' | 'pageSize' | 'total'>
) {
  const isMobile = useAppSelector(getIsMobile);

  const { apiFn, apiParams, immediate, isChangeURL = true, rowKey = 'id' } = config;

  const [form] = Form.useForm<AntDesign.AntDesignTableConfig<A>['apiParams']>();

  const { search } = useLocation();

  const query = parseQuery(search) as unknown as Parameters<A>[0];

  const {
    columnChecks,
    columns,
    data,
    empty,
    loading,
    pageNum,
    pageSize,
    resetSearchParams,
    searchParams,
    setColumnChecks,
    total,
    updateSearchParams
  } = useHookTable<A, GetTableData<A>, TableColumn<AntDesign.TableDataWithIndex<GetTableData<A>>>>({
    apiFn,
    apiParams: { ...apiParams, ...query },
    columns: config.columns,
    getColumnChecks: cols => {
      const checks: AntDesign.TableColumnCheck[] = [];

      cols.forEach(column => {
        if (column.key) {
          checks.push({
            checked: true,
            key: column.key as string,
            title: column.title as string
          });
        }
      });

      return checks;
    },
    getColumns: (cols, checks) => {
      const columnMap = new Map<string, TableColumn<AntDesign.TableDataWithIndex<GetTableData<A>>>>();

      cols.forEach(column => {
        if (column.key) {
          columnMap.set(column.key as string, column);
        }
      });

      const filteredColumns = checks.filter(item => item.checked).map(check => columnMap.get(check.key));

      return filteredColumns as TableColumn<AntDesign.TableDataWithIndex<GetTableData<A>>>[];
    },
    immediate,
    isChangeURL,
    transformer: res => {
      const { current = 1, records = [], size = 10, total: totalNum = 0 } = res.data || {};

      const recordsWithIndex = records.map((item, index) => {
        return {
          ...item,
          index: (current - 1) * size + index + 1
        };
      });

      return {
        data: recordsWithIndex,
        pageNum: current,
        pageSize: size,
        total: totalNum
      };
    }
  });

  // this is for mobile, if the system does not support mobile, you can use `pagination` directly
  const pagination: TablePaginationConfig = {
    current: pageNum,
    onChange: async (current: number, size: number) => {
      updateSearchParams({
        current,
        size
      });
    },
    pageSize,
    pageSizeOptions: ['10', '15', '20', '25', '30'],
    showSizeChanger: true,
    simple: isMobile,
    total,
    ...paginationConfig
  };
  function reset() {
    form.setFieldsValue(apiParams as NonNullable<Parameters<A>[0]>);

    resetSearchParams();
  }

  async function run(isResetCurrent: boolean = true) {
    const res = await form.validateFields();

    if (res) {
      if (isResetCurrent) {
        const { current = 1, ...rest } = res;
        updateSearchParams({ current, ...rest });
      } else {
        updateSearchParams(res);
      }
    }
  }

  return {
    columnChecks,
    data,
    empty,
    run,
    searchParams,
    searchProps: {
      form,
      reset,
      search: run,
      searchParams: searchParams as NonNullable<Parameters<A>[0]>
    },
    setColumnChecks,
    tableProps: {
      columns,
      dataSource: data,
      loading,
      pagination,
      rowKey
    }
  };
}
// data,          // 1. 当前的表格数据源
//  getData,       // 2. 刷新数据的函数（通常是 useTable 返回的 run）
// executeResActions // 3. 具体的业务请求逻辑（新增/编辑接口调用）
export function useTableOperate<T extends TableData = TableData>(
  data: T[],
  getData: (isResetCurrent?: boolean) => Promise<void>,
  executeResActions: (res: T, operateType: AntDesign.TableOperateType) => void
) {
  const { bool: drawerVisible, setFalse: closeDrawer, setTrue: openDrawer } = useBoolean();

  const { t } = useTranslation();

  const [operateType, setOperateType] = useState<AntDesign.TableOperateType>('add');

  const [form] = Form.useForm<T>();

  function handleAdd() {
    setOperateType('add');
    openDrawer();
  }

  /** the editing row data */
  const [editingData, setEditingData] = useState<T>();

  function handleEdit(idOrData: T['id'] | T) {
    if (typeof idOrData === 'object') {
      form.setFieldsValue(idOrData);

      setEditingData(idOrData);
    } else {
      const findItem = data.find(item => item.id === idOrData);
      if (findItem) {
        form.setFieldsValue(findItem);

        setEditingData(findItem);
      }
    }

    setOperateType('edit');
    openDrawer();
  }

  /** the checked row keys of table */
  const [checkedRowKeys, setCheckedRowKeys] = useState<React.Key[]>([]);

  function onSelectChange(keys: React.Key[]) {
    setCheckedRowKeys(keys);
  }

  const rowSelection: TableProps<T>['rowSelection'] = {
    columnWidth: 48,
    fixed: true,
    onChange: onSelectChange,
    selectedRowKeys: checkedRowKeys,
    type: 'checkbox'
  };

  function onClose() {
    closeDrawer();

    form.resetFields();
  }

  /** the hook after the batch delete operation is completed */
  async function onBatchDeleted() {
    window.$message?.success(t('common.deleteSuccess'));
    setCheckedRowKeys([]);

    await getData(false);
  }

  /** the hook after the delete operation is completed */
  async function onDeleted() {
    window.$message?.success(t('common.deleteSuccess'));

    await getData(false);
  }

  async function handleSubmit() {
    const res = await form.validateFields();

    // request
    await executeResActions(res, operateType);

    window.$message?.success(t('common.updateSuccess'));

    onClose();
    getData();
  }

  return {
    checkedRowKeys,//当前选中的行 ID 数组。传给 ATable 的 rowSelection 实现多选高亮。
    closeDrawer,
    drawerVisible,
    editingData,
    generalPopupOperation: {//这是一个打包好的对象，直接传给封装好的 UserOperateDrawer\system\user\index.tsx#L18-L18) 组件即可
      form,//抽屉内部表单的实例，用于自动填充数据。
      handleSubmit,//抽屉底部“确定”按钮的点击事件。它会自动校验表单，然后调用输入的 executeResActions。
      onClose,//关闭抽屉并清空表单。
      open: drawerVisible,// 布尔值，控制抽屉显示/隐藏。
      operateType//字符串 'add' 或 'edit'，告诉抽屉现在是新增模式还是编辑模式
    },
    handleAdd,//点击“新增”按钮时调用。它会设置类型为 add 并打开抽屉。
    handleEdit,//点击表格行里的“编辑”时调用。它会先从 data 里找数据填表，再打开抽屉。
    onBatchDeleted,// 批量删除成功后的回调。除了刷新表格，还会自动清空 checkedRowKeys（取消勾选）。
    onDeleted,//单行删除成功后的回调。它会自动弹出“删除成功”提示，并调用 getData 刷新表格
    onSelectChange,
    openDrawer,
    operateType,
    rowSelection//配置好的选择器对象，直接传给 ATable。
  };
}

export function useTableScroll(scrollX: number = 702) {
  const tableWrapperRef = useRef<HTMLDivElement>(null);

  const size = useSize(tableWrapperRef);

  function getTableScrollY() {
    const height = size?.height;

    if (!height) {
      return undefined;
    }

    return height - 160;
  }

  const scrollConfig = {
    x: scrollX,// 横向最小宽度，默认 702px，防止列太多时挤压变形
    y: getTableScrollY()  // 纵向最大高度，动态计算得出
  };

  return {
    scrollConfig,   //
    tableWrapperRef //这是一个 React 的 ref 对象，必须绑定到包裹 ATable 的最外层 div 上。
  };
}

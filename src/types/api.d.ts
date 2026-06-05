/**
 * Namespace Api
 *
 * All backend api type
 */
declare namespace Api {
  namespace Common {
    /** common params of paginating */
    interface PaginatingCommonParams {
      /** current page number */
      current: number;
      /** page size */
      size: number;
      /** total count */
      total: number;
    }

    /** common params of paginating query list data */
    interface PaginatingQueryRecord<T = any> extends PaginatingCommonParams {
      records: T[];
    }

    type CommonSearchParams = Pick<Common.PaginatingCommonParams, 'current' | 'size'>;

    /**
     * enable status
     *
     * - "1": enabled
     * - "2": disabled
     */
    type EnableStatus = '1' | '2';

    /** common record */
    type CommonRecord<T = any> = {
      /** record creator */
      createBy: string;
      /** record create time */
      createTime: string;
      /** record id */
      id: number;
      /** record status */
      status: EnableStatus | null;
      /** record updater */
      updateBy: string;
      /** record update time */
      updateTime: string;
    } & T;
  }

  /**
   * namespace Auth
   *
   * backend api module: "auth"
   */
  namespace Auth {
    interface LoginToken {
      refreshToken: string;
      token: string;
    }

    interface UserInfo {
      buttons: string[];
      roles: string[];
      userId: string;
      userName: string;
    }

    type Info = {
      token: LoginToken['token'];
      userInfo: UserInfo;
    };
  }

  /**
   * namespace SystemManage
   *
   * backend api module: "systemManage"
   */
  namespace SystemManage {
    type CommonSearchParams = Pick<Common.PaginatingCommonParams, 'current' | 'size'>;

    /** role */
    type Role = Common.CommonRecord<{
      /** role code */
      roleCode: string;
      /** role description */
      roleDesc: string;
      /** role name */
      roleName: string;
    }>;

    /** role search params */
    type RoleSearchParams = CommonType.RecordNullable<
      Pick<Api.SystemManage.Role, 'roleCode' | 'roleName' | 'status'> & CommonSearchParams
    >;

    /** role list */
    type RoleList = Common.PaginatingQueryRecord<Role>;

    /** all role */
    type AllRole = Pick<Role, 'id' | 'roleCode' | 'roleName'>;

    /**
     * user gender
     *
     * - "1": "male"
     * - "2": "female"
     */
    type UserGender = '1' | '2';

    /** user */
    type User = Common.CommonRecord<{
      /** user nick name */
      nickName: string;
      /** user email */
      userEmail: string;
      /** user gender */
      userGender: UserGender | null;
      /** user name */
      userName: string;
      /** user phone */
      userPhone: string;
      /** user role code collection */
      userRoles: string[];
    }>;

    /** user search params */
    type UserSearchParams = CommonType.RecordNullable<
      Pick<Api.SystemManage.User, 'nickName' | 'status' | 'userEmail' | 'userGender' | 'userName' | 'userPhone'> &
      CommonSearchParams
    >;

    /** user list */
    type UserList = Common.PaginatingQueryRecord<User>;

    /**
     * menu type
     *
     * - "1": directory
     * - "2": menu
     */
    type MenuType = '1' | '2';

    type MenuButton = {
      /**
       * button code
       *
       * it can be used to control the button permission
       */
      code: string;
      /** button description */
      desc: string;
    };

    /**
     * icon type
     *
     * - "1": iconify icon
     * - "2": local icon
     */
    type IconType = '1' | '2';

    type MenuPropsOfRoute = any;

    type Menu = Common.CommonRecord<{
      /** buttons */
      buttons?: MenuButton[] | null;
      /** children menu */
      children?: Menu[] | null;
      /** component */
      component?: string;
      /** iconify icon name or local icon name */
      icon: string;
      /** icon type */
      iconType: IconType;
      /** menu name */
      menuName: string;
      /** menu type */
      menuType: MenuType;
      /** parent menu id */
      parentId: number;
      /** route name */
      routeName: string;
      /** route path */
      routePath: string;
    }>;

    /** menu list */
    type MenuList = Common.PaginatingQueryRecord<Menu>;

    type MenuTree = {
      children?: MenuTree[];
      id: number;
      label: string;
      pId: number;
    };
  }

  /**
   * namespace Annotation
   *
   * backend api module: "annotation"
   */
  namespace Annotation {
    /** 标注形状类型 */
    type ToolType = 'create-box' | 'create-polygon' | 'create-point';

    /** 项目标注分类配置项 */
    type ClassItem = {
      name: string;
    };

    /** 标注项目状态 */
    type ProjectStatus = 'active' | 'completed';

    /** 标注项目 */
    type Project = {
      id: number;
      projectName: string;
      description: string;
      classes: ClassItem[];
      tags: string[];
      enableComment: boolean;
      tools: ToolType[];
      totalImages: number;
      annotatedCount: number;
      status: ProjectStatus;
      /** 项目组成员（用户名列表），组内成员可见该项目 */
      memberIds: string[];
      /** 摄像头配置 */
      cameraUrl?: string;
      cameraUsername?: string;
      cameraPassword?: string;
      createBy: string;
      createTime: string;
      updateBy: string;
      updateTime: string;
    };

    /** 创建项目请求参数 */
    type ProjectCreateParams = Pick<Project, 'projectName' | 'description' | 'classes' | 'tags' | 'enableComment' | 'tools' | 'memberIds' | 'cameraUrl' | 'cameraUsername' | 'cameraPassword'>;

    /** 项目搜索参数 */
    type ProjectSearchParams = CommonType.RecordNullable<
      Pick<Project, 'projectName' | 'status'> & { memberId?: string } & Common.CommonSearchParams
    >;

    /** 项目列表 */
    type ProjectList = Common.PaginatingQueryRecord<Project>;

    /** 图片标注状态 */
    type ImageStatus = 'pending' | 'annotated' | 'reviewed';

    /** 标注图片 */
    type Image = {
      id: number;
      projectId: number;
      imageUrl: string;
      imageName: string;
      annotateStatus: ImageStatus;
      annotator: string;
      annotateTime: string;
      createTime: string;
    };

    /** 图片搜索参数 */
    type ImageSearchParams = CommonType.RecordNullable<
      Pick<Image, 'annotateStatus'> & { projectId: number } & Common.CommonSearchParams
    >;

    /** 图片列表 */
    type ImageList = Common.PaginatingQueryRecord<Image>;

    /** 上传图片结果项 */
    type UploadImageResultItem = {
      id?: number;
      filename: string;
      file_url?: string;
      thumbnail_url?: string;
      width?: number;
      height?: number;
      status: 'success' | 'failed';
      message?: string;
    };

    /** 上传图片返回 */
    type UploadImageResult = {
      total: number;
      success_count: number;
      failed_count: number;
      results: UploadImageResultItem[];
    };

    /** 标注区域（region）数据 */
    type RegionData = {
      type: ToolType;
      cls: string;
      tags: string[];
      comment?: string;
      points: number[][];
    };

    /** 标注结果 */
    type Result = {
      id: number;
      projectId: number;
      imageId: number;
      regionData: RegionData;
      createTime: string;
      updateTime: string;
    };

    /** 图片标注结果汇总 */
    type ImageResult = {
      imageId: number;
      projectId: number;
      regions: RegionData[];
      updateTime: string;
    };
  }

  /**
   * namespace Camera
   *
   * backend api module: "camera"
   */
  namespace Camera {
    /** 摄像头连通性检查结果 */
    type CheckResult = {
      connected: boolean;
      deviceName: string;
    };

    /** 截帧返回 */
    type CaptureResult = {
      id: number;
      filename: string;
      file_url: string;
      thumbnail_url: string;
      file_size: number;
      width: number;
      height: number;
    };

    /** 云台控制参数 */
    type PtzParams = {
      action: 'left' | 'right' | 'up' | 'down' | 'zoomIn' | 'zoomOut' | 'stop';
      speed?: number;
      duration?: number;
    };

    /** 分辨率 */
    type Resolution = {
      width: number;
      height: number;
    };

    /** 分辨率列表 */
    type ResolutionsResult = {
      current: Resolution;
      resolutions: Resolution[];
    };
  }

  /**
   * namespace Route
   *
   * backend api module: "route"
   */
  namespace Route {
    /** menu route */
    type MenuRoute = {
      /** route children */
      children?: MenuRoute[];
      /** route component */
      component?: string;
      /** route id */
      id: string;
      /** route meta */
      meta: {
        /** route title */
        title: string;
        /** route icon */
        icon?: string;
        /** whether to hide in menu */
        hideInMenu?: boolean;
        /** route order */
        order?: number;
        /** route roles */
        roles?: string[];
        /** whether to keep alive */
        keepAlive?: boolean;
        /** whether is constant route */
        constant?: boolean;
        /** route href */
        href?: string;
        /** multi tab */
        multiTab?: boolean;
        /** active menu */
        activeMenu?: string;
      };
      /** route name */
      name: string;
      /** route path */
      path: string;
      /** route redirect */
      redirect?: string;
    };

    /** user route */
    type UserRoute = {
      /** home page path */
      home: string;
      /** available route paths */
      routes: string[];
    };
  }
}

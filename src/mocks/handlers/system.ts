import { HttpResponse, http } from 'msw';

// 模拟数据
const mockUsers: Api.SystemManage.User[] = [
  {
    id: 1,
    userName: 'admin',
    nickName: '系统管理员',
    userEmail: 'admin@example.com',
    userPhone: '13800138000',
    userGender: '1',
    status: '1',
    userRoles: ['R_ADMIN'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-01 00:00:00',
    updateTime: '2024-01-01 00:00:00'
  },
  {
    id: 2,
    userName: 'user001',
    nickName: '张三',
    userEmail: 'zhangsan@example.com',
    userPhone: '13800138001',
    userGender: '1',
    status: '1',
    userRoles: ['R_USER'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-02 00:00:00',
    updateTime: '2024-01-02 00:00:00'
  },
  {
    id: 3,
    userName: 'user002',
    nickName: '李四',
    userEmail: 'lisi@example.com',
    userPhone: '13800138002',
    userGender: '2',
    status: '1',
    userRoles: ['R_USER'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-03 00:00:00',
    updateTime: '2024-01-03 00:00:00'
  },
  {
    id: 4,
    userName: 'user003',
    nickName: '王五',
    userEmail: 'wangwu@example.com',
    userPhone: '13800138003',
    userGender: '1',
    status: '1',
    userRoles: ['R_USER'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-04 00:00:00',
    updateTime: '2024-01-04 00:00:00'
  },
  {
    id: 5,
    userName: 'user004',
    nickName: '赵六',
    userEmail: 'zhaoliu@example.com',
    userPhone: '13800138004',
    userGender: '2',
    status: '1',
    userRoles: ['R_USER'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-05 00:00:00',
    updateTime: '2024-01-05 00:00:00'
  },
  {
    id: 6,
    userName: 'super',
    nickName: '超级管理员',
    userEmail: 'super@example.com',
    userPhone: '13800138005',
    userGender: '1',
    status: '1',
    userRoles: ['R_SUPER', 'R_ADMIN'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-06 00:00:00',
    updateTime: '2024-01-06 00:00:00'
  },
  {
    id: 7,
    userName: 'chiko',
    nickName: 'Chiko',
    userEmail: 'chiko@example.com',
    userPhone: '13800138006',
    userGender: '1',
    status: '1',
    userRoles: ['R_SUPER', 'R_ADMIN'],
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-07 00:00:00',
    updateTime: '2024-01-07 00:00:00'
  }
];

// 完整的角色数据（包含所有字段）
const mockFullRoles: Api.SystemManage.Role[] = [
  {
    id: 1,
    roleCode: 'R_SUPER',
    roleName: '超级管理员',
    roleDesc: '超级管理员，拥有所有权限',
    status: '1',
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-01 00:00:00',
    updateTime: '2024-01-01 00:00:00'
  },
  {
    id: 2,
    roleCode: 'R_ADMIN',
    roleName: '系统管理员',
    roleDesc: '系统管理员，拥有大部分权限',
    status: '1',
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-02 00:00:00',
    updateTime: '2024-01-02 00:00:00'
  },
  {
    id: 3,
    roleCode: 'R_USER',
    roleName: '普通用户',
    roleDesc: '普通用户，拥有基本权限',
    status: '1',
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-03 00:00:00',
    updateTime: '2024-01-03 00:00:00'
  },
  {
    id: 4,
    roleCode: 'GUEST',
    roleName: '访客用户',
    roleDesc: '访客用户，拥有只读权限',
    status: '1',
    createBy: 'system',
    updateBy: 'system',
    createTime: '2024-01-04 00:00:00',
    updateTime: '2024-01-04 00:00:00'
  }
];

// 用户管理处理器
export const userHandlers = [
  // 获取用户列表
  http.get('/system/user/list', ({ request }) => {
    const url = new URL(request.url);
    const current = parseInt(url.searchParams.get('current') || '1');
    const size = parseInt(url.searchParams.get('size') || '10');
    const userName = url.searchParams.get('userName');
    const nickName = url.searchParams.get('nickName');
    const userEmail = url.searchParams.get('userEmail');
    const userPhone = url.searchParams.get('userPhone');
    const userGender = url.searchParams.get('userGender');
    const status = url.searchParams.get('status');

    // 过滤数据
    let filteredUsers = [...mockUsers];

    if (userName && userName !== 'null' && userName !== '') {
      filteredUsers = filteredUsers.filter(user =>
        user.userName.toLowerCase().includes(userName.toLowerCase())
      );
    }

    if (nickName && nickName !== 'null' && nickName !== '') {
      filteredUsers = filteredUsers.filter(user =>
        user.nickName.includes(nickName)
      );
    }

    if (userEmail && userEmail !== 'null' && userEmail !== '') {
      filteredUsers = filteredUsers.filter(user =>
        user.userEmail.toLowerCase().includes(userEmail.toLowerCase())
      );
    }

    if (userPhone && userPhone !== 'null' && userPhone !== '') {
      filteredUsers = filteredUsers.filter(user =>
        user.userPhone.includes(userPhone)
      );
    }

    if (userGender && userGender !== 'null' && userGender !== '') {
      filteredUsers = filteredUsers.filter(user =>
        user.userGender === userGender
      );
    }

    if (status && status !== 'null' && status !== '') {
      const statusStr = status;
      filteredUsers = filteredUsers.filter(user =>
        user.status === statusStr
      );
    }

    // 分页
    const total = filteredUsers.length;
    const start = (current - 1) * size;
    const end = start + size;
    const records = filteredUsers.slice(start, end);

    return HttpResponse.json({
      code: 200,
      message: '获取用户列表成功',
      data: {
        records,
        total,
        current,
        size
      }
    });
  }),

  // 新增用户
  http.post('/system/user/add', async ({ request }) => {
    const userData = await request.json() as Omit<Api.SystemManage.User, 'id' | 'createTime' | 'updateTime'>;

    const newUser: Api.SystemManage.User = {
      ...userData,
      id: mockUsers.length + 1,
      createTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
      updateTime: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    mockUsers.push(newUser);

    return HttpResponse.json({
      code: 200,
      message: '用户新增成功',
      data: newUser
    });
  }),

  // 编辑用户
  http.put('/system/user/edit/:id', async ({ params, request }) => {
    const id = parseInt(params.id as string);
    const userData = await request.json() as Partial<Api.SystemManage.User>;

    const userIndex = mockUsers.findIndex(user => user.id === id);
    if (userIndex === -1) {
      return HttpResponse.json({
        code: 404,
        message: '用户不存在'
      }, { status: 404 });
    }

    mockUsers[userIndex] = {
      ...mockUsers[userIndex],
      ...userData,
      updateTime: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    return HttpResponse.json({
      code: 200,
      message: '用户编辑成功',
      data: mockUsers[userIndex]
    });
  }),

  // 删除用户
  http.delete('/system/user/delete/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const userIndex = mockUsers.findIndex(user => user.id === id);

    if (userIndex === -1) {
      return HttpResponse.json({
        code: 404,
        message: '用户不存在'
      }, { status: 404 });
    }

    mockUsers.splice(userIndex, 1);

    return HttpResponse.json({
      code: 200,
      message: '用户删除成功'
    });
  }),

  // 批量删除用户
  http.delete('/system/user/batchDelete', async ({ request }) => {
    const { ids } = await request.json() as { ids: number[] };

    ids.forEach(id => {
      const userIndex = mockUsers.findIndex(user => user.id === id);
      if (userIndex !== -1) {
        mockUsers.splice(userIndex, 1);
      }
    });

    return HttpResponse.json({
      code: 200,
      message: '批量删除成功'
    });
  }),

  // 获取用户详情
  http.get('/system/user/detail/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const user = mockUsers.find(user => user.id === id);

    if (!user) {
      return HttpResponse.json({
        code: 404,
        message: '用户不存在'
      }, { status: 404 });
    }

    return HttpResponse.json({
      code: 200,
      message: '获取用户详情成功',
      data: user
    });
  })
];

// 角色管理处理器
export const roleHandlers = [
  // 获取所有角色
  http.get('/system/role/all', () => {
    const allRoles = mockFullRoles.map(role => ({
      id: role.id,
      roleCode: role.roleCode,
      roleName: role.roleName
    }));

    return HttpResponse.json({
      code: 200,
      message: '获取所有角色成功',
      data: allRoles
    });
  }),

  // 获取角色列表
  http.get('/system/role/list', ({ request }) => {
    const url = new URL(request.url);
    const current = parseInt(url.searchParams.get('current') || '1');
    const size = parseInt(url.searchParams.get('size') || '10');
    const roleCode = url.searchParams.get('roleCode');
    const roleName = url.searchParams.get('roleName');
    const status = url.searchParams.get('status');

    // 过滤数据
    let filteredRoles = [...mockFullRoles];

    if (roleCode && roleCode !== 'null' && roleCode !== '') {
      filteredRoles = filteredRoles.filter(role =>
        role.roleCode.toLowerCase().includes(roleCode.toLowerCase())
      );
    }

    if (roleName && roleName !== 'null' && roleName !== '') {
      filteredRoles = filteredRoles.filter(role =>
        role.roleName.includes(roleName)
      );
    }

    if (status && status !== 'null' && status !== '') {
      const statusStr = status;
      filteredRoles = filteredRoles.filter(role =>
        role.status === statusStr
      );
    }

    // 分页
    const total = filteredRoles.length;
    const start = (current - 1) * size;
    const end = start + size;
    const records = filteredRoles.slice(start, end);

    return HttpResponse.json({
      code: 200,
      message: '获取角色列表成功',
      data: {
        records,
        total,
        current,
        size
      }
    });
  }),

  // 新增角色
  http.post('/system/role/add', async ({ request }) => {
    const roleData = await request.json() as Omit<Api.SystemManage.Role, 'id' | 'createTime' | 'updateTime'>;

    const newRole: Api.SystemManage.Role = {
      ...roleData,
      id: mockFullRoles.length + 1,
      createBy: 'system',
      updateBy: 'system',
      createTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
      updateTime: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    mockFullRoles.push(newRole);

    return HttpResponse.json({
      code: 200,
      message: '角色新增成功',
      data: newRole
    });
  }),

  // 编辑角色
  http.put('/system/role/edit/:id', async ({ params, request }) => {
    const id = parseInt(params.id as string);
    const roleData = await request.json() as Partial<Api.SystemManage.Role>;

    const roleIndex = mockFullRoles.findIndex(role => role.id === id);
    if (roleIndex === -1) {
      return HttpResponse.json({
        code: 404,
        message: '角色不存在'
      }, { status: 404 });
    }

    mockFullRoles[roleIndex] = {
      ...mockFullRoles[roleIndex],
      ...roleData,
      updateBy: 'system',
      updateTime: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };

    return HttpResponse.json({
      code: 200,
      message: '角色编辑成功',
      data: mockFullRoles[roleIndex]
    });
  }),

  // 删除角色
  http.delete('/system/role/delete/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const roleIndex = mockFullRoles.findIndex(role => role.id === id);

    if (roleIndex === -1) {
      return HttpResponse.json({
        code: 404,
        message: '角色不存在'
      }, { status: 404 });
    }

    mockFullRoles.splice(roleIndex, 1);

    return HttpResponse.json({
      code: 200,
      message: '角色删除成功'
    });
  })
];

// ==================== 标注项目 Mock 数据 ====================

const mockProjects: Api.Annotation.Project[] = [
  {
    id: 1,
    projectName: '道路标识标注',
    description: '标注城市道路中的交通标识，包括红绿灯、路牌、斑马线等',
    classes: [
      { name: '红绿灯' },
      { name: '路牌' },
      { name: '斑马线' }
    ],
    tags: ['白天', '夜晚', '雨天'],
    enableComment: true,
    tools: ['create-box', 'create-polygon'],
    totalImages: 5,
    annotatedCount: 2,
    status: 'active',
    memberIds: ['Admin', 'Chiko'],
    cameraUrl: 'http://192.168.1.100/ISAPI',
    cameraUsername: 'admin',
    cameraPassword: 'admin123',
    createBy: 'Chiko',
    createTime: '2025-01-01 00:00:00',
    updateBy: 'Admin',
    updateTime: '2025-03-15 00:00:00'
  },
  {
    id: 2,
    projectName: '人脸关键点标注',
    description: '标注人脸关键特征点，用于人脸识别模型训练',
    classes: [
      { name: '左眼' },
      { name: '右眼' },
      { name: '鼻子' },
      { name: '嘴巴' }
    ],
    tags: ['正脸', '侧脸', '戴眼镜'],
    enableComment: false,
    tools: ['create-point'],
    totalImages: 5,
    annotatedCount: 2,
    status: 'active',
    memberIds: ['Admin', 'Chiko'],
    createBy: 'Admin',
    createTime: '2025-02-01 00:00:00',
    updateBy: 'admin',
    updateTime: '2025-04-10 00:00:00'
  }
];

const mockImages: Api.Annotation.Image[] = [];
const mockImageResults: Map<number, Api.Annotation.RegionData[]> = new Map();

// 初始化一些模拟图片
for (let p = 1; p <= 2; p++) {
  for (let i = 1; i <= 5; i++) {
    const imgId = (p - 1) * 10 + i;
    mockImages.push({
      id: imgId,
      projectId: p,
      imageUrl: `https://picsum.photos/seed/img${p}_${i}/800/600`,
      imageName: `sample_${p}_${i}.jpg`,
      annotateStatus: i <= 2 ? 'annotated' : 'pending',
      annotator: i <= 2 ? 'admin' : '',
      annotateTime: i <= 2 ? '2025-05-01 00:00:00' : '',
      createTime: `2025-05-0${i} 00:00:00`
    });
  }
}

export const annotationHandlers = [
  // 获取项目列表
  http.get('/annotation/project/list', ({ request }) => {
    const url = new URL(request.url);
    const current = parseInt(url.searchParams.get('current') || '1');
    const size = parseInt(url.searchParams.get('size') || '10');
    const projectName = url.searchParams.get('projectName') || '';
    const status = url.searchParams.get('status') || '';
    const memberId = url.searchParams.get('memberId') || '';

    let filtered = [...mockProjects];
    if (projectName) {
      filtered = filtered.filter(p => p.projectName.includes(projectName));
    }
    if (status) {
      filtered = filtered.filter(p => p.status === status);
    }
    // 按项目组成员过滤：当前用户必须是创建人或项目组成员
    if (memberId) {
      filtered = filtered.filter(p => p.createBy === memberId || p.memberIds.includes(memberId));
    }

    const start = (current - 1) * size;
    const records = filtered.slice(start, start + size);

    return HttpResponse.json({
      code: 200,
      data: {
        records,
        current,
        size,
        total: filtered.length
      }
    });
  }),

  // 新增项目
  http.post('/annotation/project/add', async ({ request }) => {
    const body = await request.json() as Api.Annotation.ProjectCreateParams & { memberIds?: string[] };
    // 根据 token 获取当前登录用户名
    const token = request.headers.get('authorization')?.replace('Bearer ', '') || '';
    const tokenUserMap: Record<string, string> = {
      'token-chiko': 'Chiko',
      'token-super': 'Super',
      'token-admin': 'Admin',
      'token-user': 'User'
    };
    const currentUser = tokenUserMap[token] || 'admin';
    const memberIds = body.memberIds && body.memberIds.length > 0 ? body.memberIds : [currentUser];
    // 确保创建人一定在成员列表中
    if (!memberIds.includes(currentUser)) {
      memberIds.push(currentUser);
    }
    const newId = mockProjects.length > 0 ? Math.max(...mockProjects.map(p => p.id)) + 1 : 1;
    const newProject: Api.Annotation.Project = {
      id: newId,
      ...body,
      memberIds,
      totalImages: 0,
      annotatedCount: 0,
      status: 'active',
      createBy: currentUser,
      createTime: new Date().toISOString(),
      updateBy: currentUser,
      updateTime: new Date().toISOString()
    };
    mockProjects.push(newProject);

    return HttpResponse.json({
      code: 200,
      data: {
        projectId: newId,
        uploadUrl: `/annotation/image/upload/${newId}`
      }
    });
  }),

  // 编辑项目
  http.put('/annotation/project/edit/:id', async ({ params, request }) => {
    const id = parseInt(params.id as string);
    const body = await request.json() as Partial<Api.Annotation.ProjectCreateParams>;
    const project = mockProjects.find(p => p.id === id);
    if (!project) {
      return HttpResponse.json({ code: 404, message: '项目不存在' }, { status: 404 });
    }
    Object.assign(project, body, { updateTime: new Date().toISOString() });
    return HttpResponse.json({ code: 200, data: project });
  }),

  // 删除项目
  http.delete('/annotation/project/delete/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const idx = mockProjects.findIndex(p => p.id === id);
    if (idx === -1) {
      return HttpResponse.json({ code: 404, message: '项目不存在' }, { status: 404 });
    }
    mockProjects.splice(idx, 1);
    return HttpResponse.json({ code: 200, message: '删除成功' });
  }),

  // 获取项目详情
  http.get('/annotation/project/detail/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const project = mockProjects.find(p => p.id === id);
    if (!project) {
      return HttpResponse.json({ code: 404, message: '项目不存在' }, { status: 404 });
    }
    return HttpResponse.json({ code: 200, data: project });
  }),

  // 获取图片列表
  http.get('/annotation/image/list', ({ request }) => {
    const url = new URL(request.url);
    const current = parseInt(url.searchParams.get('current') || '1');
    const size = parseInt(url.searchParams.get('size') || '10');
    const projectId = parseInt(url.searchParams.get('projectId') || '1');
    const annotateStatus = url.searchParams.get('annotateStatus') || '';

    let filtered = mockImages.filter(img => img.projectId === projectId);
    if (annotateStatus) {
      filtered = filtered.filter(img => img.annotateStatus === annotateStatus);
    }

    const start = (current - 1) * size;
    const records = filtered.slice(start, start + size);

    return HttpResponse.json({
      code: 200,
      data: {
        records,
        current,
        size,
        total: filtered.length
      }
    });
  }),

  // 上传图片
  http.post('/upload/image', async ({ request }) => {
    const formData = await request.formData();
    const projectId = parseInt(formData.get('project_id') as string || '1');
    const files = formData.getAll('files') as File[];

    const newImages: Api.Annotation.Image[] = [];
    const results: Api.Annotation.UploadImageResultItem[] = [];

    for (const file of files) {
      const id = mockImages.length + 1;
      // 用 File 对象生成 blob URL 作为本地预览（注意：mock 模式下的 objectURL 只在当前会话有效）
      const imageUrl = URL.createObjectURL(file);

      const img: Api.Annotation.Image = {
        id,
        projectId,
        imageUrl,
        imageName: file.name,
        annotateStatus: 'pending',
        annotator: '',
        annotateTime: '',
        createTime: new Date().toISOString()
      };
      mockImages.push(img);
      newImages.push(img);

      results.push({
        filename: file.name,
        file_url: imageUrl,
        status: 'success'
      });
    }

    // 更新项目图片总数
    const project = mockProjects.find(p => p.id === projectId);
    if (project) {
      project.totalImages = mockImages.filter(img => img.projectId === projectId).length;
    }

    return HttpResponse.json({
      code: 200,
      data: {
        total: files.length,
        success_count: results.filter(r => r.status === 'success').length,
        failed_count: results.filter(r => r.status === 'failed').length,
        results
      }
    });
  }),

  // 删除图片
  http.delete('/upload/delete/:id', ({ params }) => {
    const id = parseInt(params.id as string);
    const idx = mockImages.findIndex(img => img.id === id);
    if (idx === -1) {
      return HttpResponse.json({ code: 404, message: '图片不存在' }, { status: 404 });
    }
    const { projectId } = mockImages[idx];
    mockImages.splice(idx, 1);

    // 更新项目图片总数
    const project = mockProjects.find(p => p.id === projectId);
    if (project) {
      project.totalImages = mockImages.filter(img => img.projectId === projectId).length;
    }

    return HttpResponse.json({ code: 200, message: '删除成功' });
  }),

  // 获取图片标注结果
  http.get('/annotation/result/image/:imageId', ({ params }) => {
    const imageId = parseInt(params.imageId as string);
    const regions = mockImageResults.get(imageId) || [];
    return HttpResponse.json({ code: 200, data: regions });
  }),

  // 保存标注结果
  http.post('/annotation/result/save', async ({ request }) => {
    const body = await request.json() as {
      projectId: number;
      imageId: number;
      regions: Api.Annotation.RegionData[];
    };
    mockImageResults.set(body.imageId, body.regions);

    // 更新图片状态和项目进度
    const image = mockImages.find(img => img.id === body.imageId);
    if (image) {
      image.annotateStatus = 'annotated';
      image.annotator = 'admin';
      image.annotateTime = new Date().toISOString();
    }

    const project = mockProjects.find(p => p.id === body.projectId);
    if (project) {
      const projectImages = mockImages.filter(img => img.projectId === body.projectId);
      project.annotatedCount = projectImages.filter(img => img.annotateStatus !== 'pending').length;
    }

    return HttpResponse.json({ code: 200, message: '保存成功' });
  }),

  // 获取项目所有标注结果
  http.get('/annotation/result/project/:projectId', ({ params }) => {
    const projectId = parseInt(params.projectId as string);
    const results: Api.Annotation.ImageResult[] = [];
    mockImageResults.forEach((regions, imageId) => {
      const image = mockImages.find(img => img.id === imageId);
      if (image && image.projectId === projectId) {
        results.push({
          imageId,
          projectId,
          regions,
          updateTime: image.annotateTime || new Date().toISOString()
        });
      }
    });
    return HttpResponse.json({ code: 200, data: results });
  })
];

// ==================== 摄像头 Mock 处理器 ====================

let cameraCaptureIdCounter = 100;

export const cameraHandlers = [
  // 检查摄像头连通性
  http.get('/api/camera/check/:projectId', ({ params }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头连接失败: 该项目未配置摄像头' });
    }
    // 模拟成功
    return HttpResponse.json({
      code: 0,
      message: '摄像头连接正常',
      data: { connected: true, deviceName: `DS-2CD2T47G2-L (项目${projectId})` }
    });
  }),

  // 截取当前帧
  http.post('/api/camera/capture/:projectId', ({ params }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头未配置' });
    }
    cameraCaptureIdCounter++;
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const filename = `camera_${timestamp}.jpg`;
    // 使用 picsum 随机图模拟截帧结果
    const randomSeed = cameraCaptureIdCounter;
    const fileUrl = `https://picsum.photos/seed/${randomSeed}/1920/1080`;
    const thumbnailUrl = `https://picsum.photos/seed/${randomSeed}/320/240`;
    return HttpResponse.json({
      code: 0,
      data: {
        imageId: cameraCaptureIdCounter,
        filename,
        fileUrl,
        thumbnailUrl
      }
    });
  }),

  // MJPEG 预览流 - 返回随机图片流（Mock 下用单张随机图代替）
  http.get('/api/camera/preview/:projectId', ({ params }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头未配置' });
    }
    // Mock: 返回随机图片，前端 img 标签会显示一张静态图模拟预览
    const seed = Date.now();
    return fetch(`https://picsum.photos/seed/${seed}/1280/720`)
      .then(async (res) => {
        const buffer = await res.arrayBuffer();
        return new HttpResponse(buffer, {
          headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-cache'
          }
        });
      })
      .catch(() => {
        return new HttpResponse('MJPEG stream unavailable in mock mode', { status: 503 });
      });
  }),

  // 云台控制
  http.post('/api/camera/ptz/:projectId', async ({ params, request }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头未配置' });
    }
    const body = await request.json() as { action: string };
    console.log(`🔷 Mock PTZ: project=${projectId}, action=${body.action}`);
    return HttpResponse.json({ code: 0, message: '云台控制指令已发送' });
  }),

  // 获取分辨率列表
  http.get('/api/camera/resolutions/:projectId', ({ params }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头未配置' });
    }
    return HttpResponse.json({
      code: 0,
      data: {
        current: { width: 1920, height: 1080 },
        resolutions: [
          { width: 3840, height: 2160 },
          { width: 2688, height: 1520 },
          { width: 1920, height: 1080 },
          { width: 1280, height: 720 },
          { width: 704, height: 576 },
          { width: 352, height: 288 }
        ]
      }
    });
  }),

  // 设置分辨率
  http.put('/api/camera/resolution/:projectId', async ({ params, request }) => {
    const projectId = Number(params.projectId);
    const project = mockProjects.find(p => p.id === projectId);
    if (!project?.cameraUrl) {
      return HttpResponse.json({ code: 1, message: '摄像头未配置' });
    }
    const body = await request.json() as { width: number; height: number };
    console.log(`🔷 Mock Set Resolution: project=${projectId}, ${body.width}x${body.height}`);
    return HttpResponse.json({ code: 0, message: '分辨率已设置' });
  })
];
